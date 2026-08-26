import {
  AppError,
  type BoothGeometry,
  type ConceptAsset,
  type ConceptCandidate,
  type IdempotencyRecord,
  type Sha256,
  type S2AssetRecord,
  type S2CandidateSource,
  type S2DesignObservation,
  type S2DesignRuleSnapshot,
  type S2InputVersion,
  type S2QaCandidateResult,
  type S2QaRun,
  type S2ReferenceDraft,
  type S2RepairAttempt,
  type S2Requirement,
  type S2RequirementObservation,
  type S2ReQaResult,
  type S2DerivedCandidate,
  type S2Operation,
  type S2Publication,
  type S2PublicationObject,
  type S2RepairPublication,
  type S2UploadPublication,
  type S2StateTransition,
  type StoreState,
  type StructuredBriefData,
  type StructuredBriefVersion,
  type UUID,
} from "./types";
import { JsonRepository, PrivateObjectStore } from "./store";
import {
  assertUuid,
  cloneJson,
  codePointLength,
  jcs,
  newUuid,
  nowUtc,
  privateStorageKey,
  sha256,
} from "./utils";
import {
  S2_MAX_LOGOS,
  S2_MAX_MULTIPART_BODY_BYTES,
  S2_MAX_NORMALIZED_BYTES,
  S2_MAX_PIXELS_PER_ASSET,
  S2_MAX_PROVIDER_BYTES,
  S2_MAX_REFERENCES,
  S2_MAX_REPAIR_IMAGES,
  S2_MAX_REPAIR_OUTPUT_BYTES,
  S2_MAX_TOTAL_ASSETS,
  S2_MAX_TOTAL_PIXELS,
  S2_MAX_TOTAL_RGBA_BYTES,
  enforceS2AggregateLimits,
  inspectCanonicalS1Png,
  normalizeS2Media,
  assertS2Png,
  s2NormalizedMeasure,
} from "./s2-media";
import {
  S2_QA_MODEL,
  S2_QA_SCHEMA,
  S2_REPAIR_MODEL,
  type S2ProviderContract,
  type S2QaProviderInput,
  type S2RepairProviderInput,
} from "./s2-provider";
import { ProviderFailure } from "./openai";

export type S2WorkflowServiceOptions = {
  repository: JsonRepository;
  objects: PrivateObjectStore;
  provider: S2ProviderContract;
  clock?: () => string;
  uuid?: () => UUID;
  workerId?: string;
  processId?: number;
  isProcessAlive?: (processId: number) => boolean;
  onPublicationPhase?: (phase: "after-final-promotion", publication: S2Publication) => "interrupt" | void;
};

export type S2PublicAsset = {
  id: UUID;
  projectId: UUID;
  kind: "reference" | "logo";
  status: "ready" | "deleted";
  originalSha256: Sha256;
  originalBytes: number;
  normalizedSha256: Sha256;
  normalizedBytes: number;
  detectedMime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  pixelCount: number;
  hasAlpha: boolean;
  createdAt: string;
  deletedAt: string | null;
};

export type S2PublicDraft = {
  id: UUID;
  projectId: UUID;
  revision: number;
  status: "editable" | "frozen";
  referenceAssetIds: UUID[];
  logoAssetIds: UUID[];
  updatedAt: string;
  frozenAt: string | null;
  frozenByQaRunId: UUID | null;
  assets: S2PublicAsset[];
};

export type S2Mutation<T> = T & { replayed: boolean };

const S2_OPERATION_PREFIX = "s2_";
const SOURCE_PROVIDER_BYTES = 16 * 1024 * 1024;
const CONFIDENCE_THRESHOLD = 0.75;
const DESIGN_RULES_VERSION = "s2-design-rules-v1" as const;
const DECODER_PROFILE = "s2-media-v1" as const;

class SimulatedProcessInterruption extends Error {
  constructor() {
    super("simulated process interruption");
    this.name = "SimulatedProcessInterruption";
  }
}

const RULE_CATALOGUE: readonly {
  ruleId: string;
  materiality: "material" | "warning";
  repairable: boolean;
}[] = [
  { ruleId: "footprint.within-boundary", materiality: "material", repairable: true },
  { ruleId: "access.open-sides", materiality: "material", repairable: true },
  { ruleId: "circulation.primary-access", materiality: "material", repairable: true },
  { ruleId: "zones.inside-footprint", materiality: "material", repairable: true },
  { ruleId: "scale.human", materiality: "material", repairable: true },
  { ruleId: "structure.no-floating", materiality: "material", repairable: true },
  { ruleId: "structure.overhead-support", materiality: "material", repairable: true },
  { ruleId: "structure.screen-support", materiality: "material", repairable: true },
  { ruleId: "geometry.max-height", materiality: "material", repairable: false },
  { ruleId: "geometry.intersections", materiality: "material", repairable: true },
  { ruleId: "branding.prohibited", materiality: "material", repairable: true },
  { ruleId: "branding.style", materiality: "warning", repairable: false },
  { ruleId: "rigging.confirmation", materiality: "warning", repairable: false },
  { ruleId: "budget.complexity", materiality: "warning", repairable: false },
];

const REPAIR_OBJECTIVES: Record<string, string> = {
  "footprint.within-boundary": "Keep every visible element within the exact supplied width and depth footprint. Recompose or reduce only enough to remove the visible boundary violation.",
  "access.open-sides": "Keep every supplied open side visibly clear and approachable. Remove or reposition only the obstruction; do not change the supplied open-side fact.",
  "circulation.primary-access": "Restore a visibly usable primary approach and circulation path without removing a confirmed required zone.",
  "zones.inside-footprint": "Keep every confirmed functional zone inside the exact footprint.",
  "structure.no-floating": "Remove visible floating or unsupported appearance by using a simple grounded visual arrangement; do not claim structural approval.",
  "structure.screen-support": "Give visible screens a plausible local support or grounded arrangement without inventing engineering facts.",
  "structure.overhead-support": "Correct the clearly unsupported overhead visual issue with a bounded visibly plausible support/grounded arrangement; do not claim engineering adequacy or approval.",
  "scale.human": "Apply a bounded plausible visual scale correction so doors, counters, furniture and circulation read coherently; do not change hard geometry or claim engineering/venue approval.",
  "geometry.intersections": "Resolve the named visible collision or impossible overlap while preserving unaffected confirmed elements.",
  "branding.prohibited": "Remove the prohibited visual treatment or text and preserve only approved, explicitly supplied branding.",
};

const SPATIAL_FINDINGS = new Set([
  "footprint.within-boundary",
  "access.open-sides",
  "circulation.primary-access",
  "zones.inside-footprint",
  "structure.no-floating",
  "structure.overhead-support",
  "structure.screen-support",
  "scale.human",
  "geometry.intersections",
]);

function appError(status: number, code: string, field = "request"): AppError {
  return new AppError(status, code, [{ field, code }]);
}

function operationInputHash(operation: string, projectId: UUID, input: unknown): Sha256 {
  return sha256(jcs({ operation, projectId, input }));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const allowed = new Set(expected);
  const errors: { field: string; code: string }[] = [];
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push({ field: key, code: "REQUIRED" });
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push({ field: key, code: "UNKNOWN_FIELD" });
  }
  if (errors.length) throw new AppError(400, "INVALID_REQUEST", errors);
}

function isPending(status: string): boolean {
  return status === "queued" || status === "running";
}

function isTerminalCandidate(status: string): boolean {
  return status === "pass" || status === "warning" || status === "material_fail" ||
    status === "qa_unavailable_terminal";
}

function safeProviderRequestId(value: string | null): string | null {
  return value && value.length <= 200 ? value : null;
}

function arrayEqual(left: readonly UUID[], right: readonly UUID[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sourceProjection(source: S2CandidateSource): Record<string, unknown> {
  return {
    candidateId: source.candidateId,
    candidateIndex: source.candidateIndex,
    sourceAssetId: source.sourceAssetId,
    sourceSha256: source.sourceSha256,
    sourceByteSize: source.sourceByteSize,
    sourceWidth: source.sourceWidth,
    sourceHeight: source.sourceHeight,
    sourcePixelCount: source.sourcePixelCount,
    sourceDecodedRgbaBytes: source.sourceDecodedRgbaBytes,
  };
}

function assetManifest(state: StoreState, ids: readonly UUID[]): Record<string, unknown>[] {
  return ids.map((assetId, index) => {
    const asset = state.s2Assets.find((item) => item.id === assetId);
    if (!asset || asset.status !== "ready") throw appError(404, "ASSET_NOT_FOUND", "assetId");
    return {
      assetId: asset.id,
      normalizedSha256: asset.normalizedSha256,
      width: asset.width,
      height: asset.height,
      normalizedBytes: asset.normalizedBytes,
      slot: index + 1,
    };
  });
}

function geometryText(geometry: BoothGeometry): string {
  return "widthMm=" + geometry.widthMm + "; depthMm=" + geometry.depthMm +
    "; openSides=" + geometry.openSides.join(",") +
    "; maxHeightMm=" + (geometry.maxHeightMm === null ? "not supplied" : geometry.maxHeightMm);
}

function requirementSnapshot(brief: StructuredBriefData, geometry: BoothGeometry): S2Requirement[] {
  const result: S2Requirement[] = [
    {
      requirementId: "geometry.width",
      category: "geometry",
      expected: "present",
      expectedCount: null,
      expectedValue: geometry.widthMm,
      criticality: "material",
      source: "geometry_snapshot",
      text: "The booth width is exactly " + geometry.widthMm + " mm.",
    },
    {
      requirementId: "geometry.depth",
      category: "geometry",
      expected: "present",
      expectedCount: null,
      expectedValue: geometry.depthMm,
      criticality: "material",
      source: "geometry_snapshot",
      text: "The booth depth is exactly " + geometry.depthMm + " mm.",
    },
    {
      requirementId: "access.open-sides",
      category: "geometry",
      expected: "present",
      expectedCount: null,
      expectedValue: geometry.openSides.join(","),
      criticality: "material",
      source: "geometry_snapshot",
      text: "The supplied open sides remain visibly accessible: " + geometry.openSides.join(", ") + ".",
    },
  ];
  if (geometry.maxHeightMm !== null) {
    result.push({
      requirementId: "geometry.max-height",
      category: "geometry",
      expected: "present",
      expectedCount: null,
      expectedValue: geometry.maxHeightMm,
      criticality: "material",
      source: "geometry_snapshot",
      text: "Nothing visibly exceeds the supplied maximum height of " + geometry.maxHeightMm + " mm.",
    });
  }
  brief.functionalRequirements.forEach((item, index) => {
    const requirementId = "brief.functional." + String(index + 1).padStart(3, "0");
    const exact = item.countIsExact && item.count !== null;
    result.push({
      requirementId,
      category: "functional",
      expected: exact ? "exact_count" : "present",
      expectedCount: exact ? item.count : null,
      expectedValue: item.name,
      criticality: "material",
      source: "confirmed_brief",
      text: item.details ? item.name + ": " + item.details : item.name,
    });
  });
  brief.mandatoryRequirements.forEach((item, index) => {
    result.push({
      requirementId: "brief.mandatory." + String(index + 1).padStart(3, "0"),
      category: "mandatory",
      expected: "present",
      expectedCount: null,
      expectedValue: item,
      criticality: "material",
      source: "confirmed_brief",
      text: item,
    });
  });
  brief.prohibitedRequirements.forEach((item, index) => {
    result.push({
      requirementId: "brief.prohibited." + String(index + 1).padStart(3, "0"),
      category: "prohibited",
      expected: "absent",
      expectedCount: null,
      expectedValue: item,
      criticality: "material",
      source: "confirmed_brief",
      text: item,
    });
  });
  brief.freeTextRequirements.forEach((item, index) => {
    result.push({
      requirementId: "brief.free-text." + String(index + 1).padStart(3, "0"),
      category: "free_text",
      expected: "present",
      expectedCount: null,
      expectedValue: item,
      criticality: "warning",
      source: "confirmed_brief",
      text: item,
    });
  });
  return result;
}

function ruleSnapshot(geometry: BoothGeometry): S2DesignRuleSnapshot[] {
  return RULE_CATALOGUE.map((rule) => ({
    ruleId: rule.ruleId,
    applicability: rule.ruleId === "geometry.max-height" && geometry.maxHeightMm === null
      ? "not_applicable"
      : "applicable",
    materiality: rule.materiality,
    repairable: rule.repairable,
  }));
}

function findingOrder(id: string): number {
  const index = RULE_CATALOGUE.findIndex((rule) => rule.ruleId === id);
  if (index >= 0) return index;
  const match = id.match(/^brief\.(functional|mandatory)\.(\d{3})$/);
  if (match) {
    const base = match[1] === "functional" ? 100 : 1000;
    return base + Number(match[2]);
  }
  return 10000 + id.length;
}

function orderedFindingIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids)).sort((left, right) => {
    const order = findingOrder(left) - findingOrder(right);
    return order || left.localeCompare(right);
  });
}

function isFunctionalFinding(id: string): boolean {
  return /^brief\.(functional|mandatory)\.\d{3}$/.test(id);
}

function compatibleFindingSet(ids: readonly string[]): boolean {
  if (ids.length < 1 || ids.length > 3) return false;
  const unique = orderedFindingIds(ids);
  if (unique.length !== ids.length) return false;
  if (unique.some((id) => !SPATIAL_FINDINGS.has(id) && id !== "branding.prohibited" && !isFunctionalFinding(id))) {
    return false;
  }
  const functionalCount = unique.filter(isFunctionalFinding).length;
  const brandingCount = unique.includes("branding.prohibited") ? 1 : 0;
  return functionalCount <= 1 && brandingCount <= 1;
}

function objectiveForFinding(id: string, requirements: readonly S2Requirement[]): string {
  const fixed = REPAIR_OBJECTIVES[id];
  if (fixed) return fixed;
  const requirement = requirements.find((item) => item.requirementId === id);
  if (!requirement) throw appError(409, "REPAIR_NOT_ELIGIBLE");
  const family = id.startsWith("brief.functional.") ? "functional" : "mandatory";
  return "Make the explicit " + family + " requirement visible and correctly represented without changing the confirmed brief: " + requirement.text;
}

function repairManifestHash(referenceAssets: readonly Record<string, unknown>[], logoAssets: readonly Record<string, unknown>[]): Sha256 {
  return sha256(jcs({ referenceAssets, logoAssets }));
}

function renderRepairPrompt(input: S2InputVersion, source: S2CandidateSource, findings: readonly string[], manifestHash: Sha256): string {
  const requirements = input.canonicalRequirements;
  const objectives = orderedFindingIds(findings).map((id) => objectiveForFinding(id, requirements));
  const lines = [
    "Role and output instruction: Edit the supplied booth concept image once. Return exactly one PNG image. Preserve the source concept and make only the bounded visual corrections listed below.",
    "Hard geometry facts: " + geometryText(input.geometrySnapshot) + ".",
    "Confirmed brief requirements: " + requirements.filter((item) => item.category !== "geometry").map((item) => item.text).join(" | ") + ".",
    "Confirmed prohibitions: " + requirements.filter((item) => item.category === "prohibited").map((item) => String(item.expectedValue)).join(" | ") + ".",
    "Repair objectives: " + objectives.join(" | "),
    "Image roles: Image 1 is the exact canonical S1 source candidate (candidateIndex=" + source.candidateIndex + ", sourceSha256=" + source.sourceSha256 + "). Following images, in order, are optional normalized reference assets and then optional normalized logo assets. Use them only as visual guidance. Stable role-ordered manifest hash: " + manifestHash + ".",
    "Preservation constraints: Do not change width, depth, open sides, supplied maximum height, candidate identity, source lineage, or confirmed brief facts. Do not add engineering, rigging, venue, legal, fabrication, approval, cost, or unconfirmed branding claims.",
    "Visual-only disclosure: This bounded edit is a visual/design correction and is not engineering, structural, venue, fabrication, legal, or approval confirmation.",
  ];
  return lines.join("\n") + "\n";
}

function publicAsset(asset: S2AssetRecord): S2PublicAsset {
  return {
    id: asset.id,
    projectId: asset.projectId,
    kind: asset.kind,
    status: asset.status,
    originalSha256: asset.originalSha256,
    originalBytes: asset.originalBytes,
    normalizedSha256: asset.normalizedSha256,
    normalizedBytes: asset.normalizedBytes,
    detectedMime: asset.detectedMime,
    width: asset.width,
    height: asset.height,
    pixelCount: asset.pixelCount,
    hasAlpha: asset.hasAlpha,
    createdAt: asset.createdAt,
    deletedAt: asset.deletedAt,
  };
}

function publicDraft(state: StoreState, draft: S2ReferenceDraft): S2PublicDraft {
  return {
    ...cloneJson(draft),
    assets: state.s2Assets.filter((asset) => asset.projectId === draft.projectId).map(publicAsset),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecordKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => expected.has(key));
}

function validateProviderObservation(
  payload: unknown,
  input: S2InputVersion,
): { requirements: Record<string, unknown>[]; designRules: Record<string, unknown>[] } {
  if (!isObject(payload) || !exactRecordKeys(payload, ["requirements", "designRules"]) ||
      !Array.isArray(payload.requirements) || !Array.isArray(payload.designRules)) {
    throw appError(502, "QA_SCHEMA_INVALID");
  }
  const requirements = payload.requirements;
  const designRules = payload.designRules;
  const expectedRequirements = input.canonicalRequirements;
  const expectedRules = input.designRuleSnapshot.filter((rule) => rule.applicability === "applicable");
  const seenRequirements = new Set<string>();
  const seenRules = new Set<string>();
  const validObserved = new Set(["present", "absent", "uncertain", "not_verifiable"]);
  const validDesignObserved = new Set(["compliant", "non_compliant", "uncertain", "not_verifiable"]);
  for (const raw of requirements) {
    if (!isObject(raw) || !exactRecordKeys(raw, ["requirementId", "expected", "expectedCount", "observed", "observedCount", "confidence", "evidence"])) {
      throw appError(502, "QA_SCHEMA_INVALID");
    }
    const requirementId = raw.requirementId;
    if (typeof requirementId !== "string" || seenRequirements.has(requirementId)) throw appError(502, "QA_SCHEMA_INVALID");
    const expected = expectedRequirements.find((item) => item.requirementId === requirementId);
    if (!expected || raw.expected !== expected.expected || raw.expectedCount !== expected.expectedCount) {
      throw appError(502, "QA_SCHEMA_INVALID");
    }
    if (!validObserved.has(String(raw.observed)) || typeof raw.confidence !== "number" ||
        !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1 ||
        typeof raw.evidence !== "string" || codePointLength(raw.evidence) > 400) {
      throw appError(502, "QA_SCHEMA_INVALID");
    }
    const observedCount = raw.observedCount;
    if (observedCount !== null && (typeof observedCount !== "number" || !Number.isInteger(observedCount) || observedCount < 0)) {
      throw appError(502, "QA_SCHEMA_INVALID");
    }
    const judgedCount = expected.expected === "exact_count" && (raw.observed === "present" || raw.observed === "absent") &&
      raw.confidence >= CONFIDENCE_THRESHOLD;
    if (expected.expected === "exact_count" && judgedCount && observedCount === null) {
      throw appError(502, "QA_SCHEMA_INVALID");
    }
    if (expected.expected !== "exact_count" && observedCount !== null) {
      throw appError(502, "QA_SCHEMA_INVALID");
    }
    seenRequirements.add(requirementId);
  }
  for (const expected of expectedRequirements) if (!seenRequirements.has(expected.requirementId)) throw appError(502, "QA_SCHEMA_INVALID");
  for (const raw of designRules) {
    if (!isObject(raw) || !exactRecordKeys(raw, ["ruleId", "observed", "confidence", "evidence"])) throw appError(502, "QA_SCHEMA_INVALID");
    const ruleId = raw.ruleId;
    if (typeof ruleId !== "string" || seenRules.has(ruleId)) throw appError(502, "QA_SCHEMA_INVALID");
    const expected = expectedRules.find((item) => item.ruleId === ruleId);
    if (!expected || !validDesignObserved.has(String(raw.observed)) ||
        typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1 ||
        typeof raw.evidence !== "string" || codePointLength(raw.evidence) > 400) {
      throw appError(502, "QA_SCHEMA_INVALID");
    }
    seenRules.add(ruleId);
  }
  for (const expected of expectedRules) if (!seenRules.has(expected.ruleId)) throw appError(502, "QA_SCHEMA_INVALID");
  return { requirements, designRules };
}

type EvaluatedObservation = {
  requirements: S2RequirementObservation[];
  designRules: S2DesignObservation[];
  materialFindingIds: string[];
  warningFindingIds: string[];
  uncertainFindingIds: string[];
  verdict: "PASS" | "WARNING" | "MATERIAL_FAIL";
};

function evaluateObservations(
  payload: { requirements: Record<string, unknown>[]; designRules: Record<string, unknown>[] },
  input: S2InputVersion,
): EvaluatedObservation {
  const requirements: S2RequirementObservation[] = [];
  const designRules: S2DesignObservation[] = [];
  const materialFindingIds: string[] = [];
  const warningFindingIds: string[] = [];
  const uncertainFindingIds: string[] = [];
  for (const expected of input.canonicalRequirements) {
    const raw = payload.requirements.find((item) => item.requirementId === expected.requirementId) as Record<string, unknown>;
    const observed = raw.observed as S2RequirementObservation["observed"];
    const confidence = raw.confidence as number;
    const observedCount = raw.observedCount as number | null;
    const record: S2RequirementObservation = {
      requirementId: expected.requirementId,
      expected: expected.expected,
      expectedCount: expected.expectedCount,
      expectedValue: cloneJson(expected.expectedValue),
      observed,
      observedCount,
      confidence,
      evidence: raw.evidence as string,
    };
    requirements.push(record);
    let uncertain = confidence < CONFIDENCE_THRESHOLD || observed === "uncertain" || observed === "not_verifiable";
    let violation = false;
    if (!uncertain) {
      if (expected.expected === "present" && observed === "absent") violation = true;
      if (expected.expected === "absent" && observed === "present") violation = true;
      if (expected.expected === "exact_count" && observedCount !== expected.expectedCount) violation = true;
    }
    if (uncertain) uncertainFindingIds.push("uncertain:" + expected.requirementId);
    if (violation) {
      if (expected.criticality === "material") materialFindingIds.push(expected.requirementId);
      else warningFindingIds.push(expected.requirementId);
    }
  }
  for (const expected of input.designRuleSnapshot) {
    if (expected.applicability !== "applicable") continue;
    const raw = payload.designRules.find((item) => item.ruleId === expected.ruleId) as Record<string, unknown>;
    const observed = raw.observed as S2DesignObservation["observed"];
    const confidence = raw.confidence as number;
    const record: S2DesignObservation = {
      ruleId: expected.ruleId,
      observed,
      confidence,
      evidence: raw.evidence as string,
    };
    designRules.push(record);
    const uncertain = confidence < CONFIDENCE_THRESHOLD || observed === "uncertain" || observed === "not_verifiable";
    if (uncertain) uncertainFindingIds.push("uncertain:" + expected.ruleId);
    if (!uncertain && observed === "non_compliant") {
      if (expected.materiality === "material") materialFindingIds.push(expected.ruleId);
      else warningFindingIds.push(expected.ruleId);
    }
  }
  const verdict = materialFindingIds.length ? "MATERIAL_FAIL" :
    uncertainFindingIds.length || warningFindingIds.length ? "WARNING" : "PASS";
  return { requirements, designRules, materialFindingIds, warningFindingIds, uncertainFindingIds, verdict };
}

function retryableFailure(error: unknown): boolean {
  if (!(error instanceof ProviderFailure)) return false;
  return ["PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMIT", "PROVIDER_SERVER_ERROR", "QA_PROVIDER_INCOMPLETE"].includes(error.safeCode);
}

export class S2WorkflowService {
  private readonly repository: JsonRepository;
  private readonly objects: PrivateObjectStore;
  private readonly provider: S2ProviderContract;
  private readonly clock: () => string;
  private readonly uuid: () => UUID;
  private readonly workerId: string;
  private readonly processId: number;
  private readonly isProcessAlive: (processId: number) => boolean;
  private readonly onPublicationPhase: S2WorkflowServiceOptions["onPublicationPhase"];
  private readonly inFlight = new Set<string>();

  constructor(options: S2WorkflowServiceOptions) {
    this.repository = options.repository;
    this.objects = options.objects;
    this.provider = options.provider;
    this.clock = options.clock ?? nowUtc;
    this.uuid = options.uuid ?? newUuid;
    this.processId = options.processId ?? process.pid;
    this.workerId = options.workerId ?? "s2-process-" + this.processId + "-" + this.uuid();
    this.isProcessAlive = options.isProcessAlive ?? ((processId) => {
      try {
        process.kill(processId, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    });
    this.onPublicationPhase = options.onPublicationPhase;
    this.recoverPublications();
    this.recoverPendingOperations();
  }

  private state(): StoreState {
    return this.repository.state();
  }

  private projectExists(state: StoreState, projectId: UUID): void {
    if (!state.projects.some((project) => project.projectId === projectId)) throw appError(404, "PROJECT_NOT_FOUND", "projectId");
  }

  private s2Project(state: StoreState, projectId: UUID): void {
    const project = state.projects.find((item) => item.projectId === projectId);
    if (!project) throw appError(404, "PROJECT_NOT_FOUND", "projectId");
    if (project.status !== "concepts_ready" || !project.confirmedBriefVersionId || !project.boothGeometry) {
      throw appError(409, "S2_NOT_AVAILABLE");
    }
  }

  private draftIn(state: StoreState, projectId: UUID, create = false): S2ReferenceDraft {
    const existing = state.s2Drafts.find((draft) => draft.projectId === projectId);
    if (existing) return existing;
    if (!create) throw appError(404, "S2_INPUT_NOT_FOUND", "draft");
    const timestamp = this.clock();
    const draft: S2ReferenceDraft = {
      id: this.uuid(),
      projectId,
      revision: 1,
      status: "editable",
      referenceAssetIds: [],
      logoAssetIds: [],
      updatedAt: timestamp,
      frozenAt: null,
      frozenByQaRunId: null,
    };
    state.s2Drafts.push(draft);
    return draft;
  }

  private rememberIdempotency(state: StoreState, key: UUID, operation: string, projectId: UUID, inputHash: Sha256, result: Record<string, unknown>): void {
    state.idempotency.push({ key, operation, projectId, inputHash, result: cloneJson(result), createdAt: this.clock() });
  }

  private idempotencyIn(state: StoreState, key: UUID, operation: string, projectId: UUID, inputHash: Sha256): IdempotencyRecord | null {
    const existing = state.idempotency.find((item) => item.key === key);
    if (!existing) return null;
    if (existing.operation !== operation || existing.projectId !== projectId || existing.inputHash !== inputHash) throw appError(409, "IDEMPOTENCY_KEY_REUSE");
    return existing;
  }

  private claimMatches(operation: S2Operation, token: UUID): boolean {
    return operation.status === "running" && operation.claimedBy === this.workerId &&
      operation.claimedProcessId === this.processId && operation.claimToken === token;
  }

  private claimIsLive(operation: S2Operation): boolean {
    if (operation.status !== "running" || operation.claimedProcessId === null) return operation.status === "running";
    try {
      return this.isProcessAlive(operation.claimedProcessId);
    } catch {
      return true;
    }
  }

  private clearClaim(operation: S2Operation): void {
    operation.claimedBy = null;
    operation.claimedProcessId = null;
    operation.claimToken = null;
    operation.claimedAt = null;
  }

  private verifyObject(storageKey: string, expectedBytes: number, expectedSha256: Sha256): void {
    try {
      const bytes = this.objects.read(storageKey);
      if (bytes.byteLength !== expectedBytes || sha256(bytes) !== expectedSha256) throw new Error("object identity mismatch");
    } catch {
      throw appError(500, "PERSISTENCE_FAILED");
    }
  }

  private publicationObjectMatches(object: S2PublicationObject): boolean {
    try {
      const bytes = this.objects.read(object.key);
      return bytes.byteLength === object.byteSize && sha256(bytes) === object.sha256;
    } catch {
      return false;
    }
  }

  private publicationFinalsMatch(publication: S2Publication): boolean {
    return publication.finalObjects.every((object) => this.publicationObjectMatches(object));
  }

  private referencedPrivateObjectKeys(state: StoreState): Set<string> {
    const keys = new Set<string>();
    state.conceptAssets.forEach((asset) => keys.add(asset.storageKey));
    state.s2Assets.forEach((asset) => {
      keys.add(asset.storageKeyOriginal);
      keys.add(asset.storageKeyNormalized);
    });
    state.s2DerivedCandidates.forEach((candidate) => keys.add(candidate.storageKeyNormalized));
    return keys;
  }

  private cleanupPublicationObjects(publication: S2Publication, removeFinal: boolean): void {
    publication.stagingObjects.forEach((object) => this.objects.remove(object.key));
    if (!removeFinal) return;
    const referenced = this.referencedPrivateObjectKeys(this.state());
    publication.finalObjects.forEach((object) => {
      if (!referenced.has(object.key)) this.objects.remove(object.key);
    });
  }

  private notifyPublicationPromoted(publication: S2Publication): void {
    if (this.onPublicationPhase?.("after-final-promotion", cloneJson(publication)) === "interrupt") {
      throw new SimulatedProcessInterruption();
    }
  }

  private markPublicationState(publicationId: UUID, stateValue: "promoted" | "aborted"): void {
    this.repository.transact((state) => {
      const publication = state.s2Publications.find((item) => item.id === publicationId);
      if (!publication || publication.state === "committed") throw appError(500, "PERSISTENCE_FAILED");
      publication.state = stateValue;
      publication.updatedAt = this.clock();
    });
  }

  private recoverPublications(): void {
    const pending = this.state().s2Publications
      .filter((publication) => publication.state === "staged" || publication.state === "promoted")
      .map((publication) => cloneJson(publication));
    for (const snapshot of pending) {
      const outcome = this.repository.transact((state) => {
        const publication = state.s2Publications.find((item) => item.id === snapshot.id);
        if (!publication || (publication.state !== "staged" && publication.state !== "promoted")) return null;
        if (publication.kind === "asset_upload") return this.reconcileUploadPublication(state, publication);
        return this.reconcileRepairPublication(state, publication);
      });
      if (!outcome) continue;
      if (outcome.cleanupFinal) this.cleanupPublicationObjects(snapshot, true);
      else this.cleanupPublicationObjects(snapshot, false);
      if (outcome.startOperationId) this.startOperation(outcome.startOperationId);
    }
  }

  private reconcileUploadPublication(state: StoreState, publication: S2UploadPublication): { cleanupFinal: boolean; startOperationId: UUID | null } {
    const finalMatches = this.publicationFinalsMatch(publication);
    const existingAsset = state.s2Assets.find((asset) => asset.id === publication.assetId);
    const existingIdempotency = state.idempotency.find((item) => item.key === publication.idempotencyKey);
    const assetMatches = existingAsset?.status === "ready" && existingAsset.projectId === publication.projectId &&
      existingAsset.storageKeyOriginal === publication.intendedAsset.storageKeyOriginal &&
      existingAsset.storageKeyNormalized === publication.intendedAsset.storageKeyNormalized &&
      existingAsset.originalSha256 === publication.intendedAsset.originalSha256 &&
      existingAsset.normalizedSha256 === publication.intendedAsset.normalizedSha256 &&
      existingAsset.originalBytes === publication.intendedAsset.originalBytes &&
      existingAsset.normalizedBytes === publication.intendedAsset.normalizedBytes;
    if (finalMatches && assetMatches && existingIdempotency?.result.assetId === publication.assetId) {
      publication.state = "committed";
      publication.updatedAt = this.clock();
      return { cleanupFinal: false, startOperationId: null };
    }
    if (!finalMatches || !state.projects.some((project) => project.projectId === publication.projectId)) {
      publication.state = "aborted";
      publication.updatedAt = this.clock();
      return { cleanupFinal: true, startOperationId: null };
    }
    const project = state.projects.find((item) => item.projectId === publication.projectId);
    const draft = state.s2Drafts.find((item) => item.projectId === publication.projectId);
    if (!project || project.status !== "concepts_ready" || draft?.status === "frozen") {
      publication.state = "aborted";
      publication.updatedAt = this.clock();
      return { cleanupFinal: true, startOperationId: null };
    }
    if (existingIdempotency && (existingIdempotency.operation !== "s2_asset_upload" ||
        existingIdempotency.projectId !== publication.projectId || existingIdempotency.inputHash !== publication.inputHash ||
        existingIdempotency.result.assetId !== publication.assetId)) {
      publication.state = "aborted";
      publication.updatedAt = this.clock();
      return { cleanupFinal: true, startOperationId: null };
    }
    if (state.s2Assets.some((asset) => asset.projectId === publication.projectId &&
        asset.originalSha256 === publication.intendedAsset.originalSha256 && asset.status === "ready" && asset.id !== publication.assetId)) {
      publication.state = "aborted";
      publication.updatedAt = this.clock();
      return { cleanupFinal: true, startOperationId: null };
    }
    if (!existingAsset) state.s2Assets.push(cloneJson(publication.intendedAsset));
    if (!existingIdempotency) {
      this.rememberIdempotency(state, publication.idempotencyKey, "s2_asset_upload", publication.projectId, publication.inputHash, { assetId: publication.assetId });
    }
    publication.state = "committed";
    publication.updatedAt = this.clock();
    return { cleanupFinal: false, startOperationId: null };
  }

  private reconcileRepairPublication(state: StoreState, publication: S2RepairPublication): { cleanupFinal: boolean; startOperationId: UUID | null } | null {
    const operation = state.s2Operations.find((item) => item.id === publication.operationId);
    const repair = state.s2Repairs.find((item) => item.id === publication.repairAttemptId);
    const run = state.s2QaRuns.find((item) => item.id === publication.qaRunId);
    if (!operation || !repair || !run) {
      publication.state = "aborted";
      publication.updatedAt = this.clock();
      return { cleanupFinal: true, startOperationId: null };
    }
    if (operation.status === "running" && this.claimIsLive(operation)) return null;
    const finalMatches = this.publicationFinalsMatch(publication);
    const existingDerived = state.s2DerivedCandidates.find((item) => item.id === publication.intendedDerived.id);
    const existingReQa = state.s2ReQaResults.find((item) => item.id === publication.intendedReQa.id);
    const existingReQaOperation = state.s2Operations.find((item) => item.id === publication.intendedReQaOperation.id);
    if (existingDerived || existingReQa || existingReQaOperation) {
      if (!finalMatches || existingDerived?.storageKeyNormalized !== publication.intendedDerived.storageKeyNormalized ||
          existingReQa?.derivedCandidateId !== publication.intendedDerived.id ||
          existingReQaOperation?.resultId !== publication.intendedReQa.id) {
        publication.state = "aborted";
        publication.updatedAt = this.clock();
        return { cleanupFinal: true, startOperationId: null };
      }
      publication.state = "committed";
      publication.updatedAt = this.clock();
      return { cleanupFinal: false, startOperationId: existingReQaOperation?.status === "queued" ? existingReQaOperation.id : null };
    }
    if (!finalMatches || operation.status === "failed") {
      repair.status = "failed";
      repair.completedAt = this.clock();
      operation.status = "failed";
      operation.failureCode = "PERSISTENCE_FAILED";
      operation.completedAt = this.clock();
      this.clearClaim(operation);
      publication.state = "aborted";
      publication.updatedAt = this.clock();
      return { cleanupFinal: true, startOperationId: null };
    }
    if (operation.status !== "queued" && operation.status !== "running") {
      publication.state = "aborted";
      publication.updatedAt = this.clock();
      return { cleanupFinal: true, startOperationId: null };
    }
    state.s2DerivedCandidates.push(cloneJson(publication.intendedDerived));
    state.s2ReQaResults.push(cloneJson(publication.intendedReQa));
    state.s2Operations.push(cloneJson(publication.intendedReQaOperation));
    repair.status = "derived_ready";
    repair.outputSha256 = publication.intendedDerived.outputSha256;
    repair.derivedCandidateId = publication.intendedDerived.id;
    repair.reQaCandidateResultId = publication.intendedReQa.id;
    repair.providerRequestId = publication.providerRequestId;
    repair.completedAt = this.clock();
    const wasRunning = operation.status === "running";
    operation.status = "succeeded";
    operation.completedAt = this.clock();
    this.clearClaim(operation);
    this.transition(state, operation.projectId, operation.id, "repair", 1, wasRunning ? "running" : "queued", "derived_ready", operation.referenceId);
    this.transition(state, operation.projectId, publication.intendedReQaOperation.id, "re_qa", 1, "derived_ready", "queued", operation.referenceId);
    publication.state = "committed";
    publication.updatedAt = this.clock();
    return { cleanupFinal: false, startOperationId: publication.intendedReQaOperation.id };
  }

  authorizeProject(projectId: UUID): void {
    this.s2Project(this.state(), projectId);
  }

  getReferenceDraft(projectId: UUID): S2PublicDraft {
    this.repository.transact((state) => {
      this.s2Project(state, projectId);
      this.draftIn(state, projectId, true);
    });
    const state = this.state();
    return publicDraft(state, this.draftIn(state, projectId));
  }

  async uploadAsset(
    projectId: UUID,
    kind: unknown,
    fileName: string | undefined,
    mimeType: string,
    bytes: Uint8Array,
    key: UUID,
  ): Promise<S2Mutation<{ asset: S2PublicAsset; draft: S2PublicDraft }>> {
    if (kind !== "reference" && kind !== "logo") throw appError(400, "INVALID_ASSET_KIND", "kind");
    const stateBefore = this.state();
    this.s2Project(stateBefore, projectId);
    const existingDraft = stateBefore.s2Drafts.find((draft) => draft.projectId === projectId);
    if (existingDraft?.status === "frozen") throw appError(409, "DRAFT_FROZEN");
    const normalized = await normalizeS2Media({ kind, fileName, mimeType, bytes, maxInputBytes: 8_388_608 });
    const inputHash = operationInputHash("s2_asset_upload", projectId, {
      kind,
      originalSha256: normalized.originalSha256,
      originalBytes: normalized.originalBytes.byteLength,
    });
    const knownReplay = this.repository.transact((state) => {
      this.s2Project(state, projectId);
      const draft = this.draftIn(state, projectId, true);
      if (draft.status === "frozen") throw appError(409, "DRAFT_FROZEN");
      const replay = this.idempotencyIn(state, key, "s2_asset_upload", projectId, inputHash);
      return replay ? String(replay.result.assetId) : null;
    });
    if (knownReplay) {
      const current = this.state();
      const asset = current.s2Assets.find((item) => item.id === knownReplay);
      if (!asset) throw appError(500, "PERSISTENCE_FAILED");
      return { asset: publicAsset(asset), draft: publicDraft(current, this.draftIn(current, projectId, true)), replayed: true };
    }
    const assetId = this.uuid();
    const stagingOriginal = privateStorageKey("projects", projectId, "s2", "staging", "reference-assets", assetId, "original");
    const stagingNormalized = privateStorageKey("projects", projectId, "s2", "staging", "reference-assets", assetId, "normalized.png");
    const finalOriginal = privateStorageKey("projects", projectId, "s2", "references", assetId, "original");
    const finalNormalized = privateStorageKey("projects", projectId, "s2", "references", assetId, "normalized.png");
    const intendedAsset: S2AssetRecord = {
      id: assetId,
      projectId,
      kind,
      status: "ready",
      originalSha256: normalized.originalSha256,
      originalBytes: normalized.originalBytes.byteLength,
      normalizedSha256: normalized.normalizedSha256,
      normalizedBytes: normalized.normalizedBytes.byteLength,
      detectedMime: normalized.detectedMime,
      width: normalized.width,
      height: normalized.height,
      pixelCount: normalized.pixelCount,
      hasAlpha: normalized.hasAlpha,
      storageKeyOriginal: finalOriginal,
      storageKeyNormalized: finalNormalized,
      createdAt: this.clock(),
      deletedAt: null,
    };
    const publication: S2UploadPublication = {
      kind: "asset_upload",
      id: this.uuid(),
      projectId,
      assetId,
      idempotencyKey: key,
      inputHash,
      stagingObjects: [
        { key: stagingOriginal, sha256: normalized.originalSha256, byteSize: normalized.originalBytes.byteLength },
        { key: stagingNormalized, sha256: normalized.normalizedSha256, byteSize: normalized.normalizedBytes.byteLength },
      ],
      finalObjects: [
        { key: finalOriginal, sha256: normalized.originalSha256, byteSize: normalized.originalBytes.byteLength },
        { key: finalNormalized, sha256: normalized.normalizedSha256, byteSize: normalized.normalizedBytes.byteLength },
      ],
      intendedAsset,
      state: "staged",
      createdAt: this.clock(),
      updatedAt: this.clock(),
    };
    try {
      this.objects.put(stagingOriginal, normalized.originalBytes);
      this.verifyObject(stagingOriginal, normalized.originalBytes.byteLength, normalized.originalSha256);
      this.objects.put(stagingNormalized, normalized.normalizedBytes);
      this.verifyObject(stagingNormalized, normalized.normalizedBytes.byteLength, normalized.normalizedSha256);
      this.repository.transact((state) => {
        this.s2Project(state, projectId);
        const draft = this.draftIn(state, projectId, true);
        if (draft.status === "frozen") throw appError(409, "DRAFT_FROZEN");
        const replay = this.idempotencyIn(state, key, "s2_asset_upload", projectId, inputHash);
        if (!replay) state.s2Publications.push(cloneJson(publication));
      });
      this.objects.promote(stagingOriginal, finalOriginal);
      this.objects.promote(stagingNormalized, finalNormalized);
      this.markPublicationState(publication.id, "promoted");
      this.notifyPublicationPromoted(publication);
      const result = this.repository.transact((state) => {
        this.s2Project(state, projectId);
        const draft = this.draftIn(state, projectId, true);
        if (draft.status === "frozen") throw appError(409, "DRAFT_FROZEN");
        const replay = this.idempotencyIn(state, key, "s2_asset_upload", projectId, inputHash);
        const storedPublication = state.s2Publications.find((item) => item.id === publication.id);
        if (replay) {
          if (storedPublication) {
            storedPublication.state = "aborted";
            storedPublication.updatedAt = this.clock();
          }
          return { assetId: String(replay.result.assetId), replayed: true };
        }
        if (!storedPublication || storedPublication.state !== "promoted") throw appError(500, "PERSISTENCE_FAILED");
        if (state.s2Assets.some((asset) => asset.projectId === projectId &&
            asset.originalSha256 === normalized.originalSha256 && asset.status === "ready")) {
          throw appError(409, "MEDIA_DUPLICATE");
        }
        state.s2Assets.push(cloneJson(intendedAsset));
        this.rememberIdempotency(state, key, "s2_asset_upload", projectId, inputHash, { assetId });
        storedPublication.state = "committed";
        storedPublication.updatedAt = this.clock();
        return { assetId, replayed: false };
      });
      this.cleanupPublicationObjects(publication, result.replayed);
      const current = this.state();
      const asset = current.s2Assets.find((item) => item.id === result.assetId);
      if (!asset) throw appError(500, "PERSISTENCE_FAILED");
      return { asset: publicAsset(asset), draft: publicDraft(current, this.draftIn(current, projectId, true)), replayed: result.replayed };
    } catch (error) {
      if (error instanceof SimulatedProcessInterruption) throw error;
      this.cleanupPublicationObjects(publication, true);
      try {
        this.markPublicationState(publication.id, "aborted");
      } catch {
        // Recovery will reconcile a durable publication record if the abort write fails.
      }
      throw error;
    }
  }
  updateDraft(
    projectId: UUID,
    expectedRevision: unknown,
    referenceAssetIds: unknown,
    logoAssetIds: unknown,
    key: UUID,
  ): S2Mutation<{ draft: S2PublicDraft }> {
    if (!Array.isArray(referenceAssetIds) || !Array.isArray(logoAssetIds)) throw appError(400, "INVALID_REQUEST");
    const refs = referenceAssetIds.map((id) => { assertUuid(id, "referenceAssetIds"); return id; });
    const logos = logoAssetIds.map((id) => { assertUuid(id, "logoAssetIds"); return id; });
    if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) throw appError(400, "INVALID_REQUEST");
    const inputHash = operationInputHash("s2_draft_update", projectId, {
      draftId: this.state().s2Drafts.find((draft) => draft.projectId === projectId)?.id ?? null,
      expectedRevision,
      referenceAssetIds: refs,
      logoAssetIds: logos,
    });
    const result = this.repository.transact((state) => {
      this.s2Project(state, projectId);
      const draft = this.draftIn(state, projectId, true);
      if (draft.status === "frozen") throw appError(409, "DRAFT_FROZEN");
      const replay = this.idempotencyIn(state, key, "s2_draft_update", projectId, inputHash);
      if (replay) return { draft: cloneJson(draft), replayed: true };
      if (draft.revision !== expectedRevision) throw appError(409, "DRAFT_REVISION_CONFLICT");
      if (new Set(refs).size !== refs.length || new Set(logos).size !== logos.length ||
          new Set([...refs, ...logos]).size !== refs.length + logos.length) throw appError(409, "MEDIA_DUPLICATE");
      if (refs.length > S2_MAX_REFERENCES || logos.length > S2_MAX_LOGOS || refs.length + logos.length > S2_MAX_TOTAL_ASSETS) {
        throw appError(422, "DRAFT_LIMIT_EXCEEDED");
      }
      for (const id of refs) {
        const asset = state.s2Assets.find((item) => item.id === id);
        if (!asset) throw appError(404, "ASSET_NOT_FOUND");
        if (asset.projectId !== projectId) throw appError(404, "ASSET_PROJECT_MISMATCH");
        if (asset.kind !== "reference") throw appError(409, "ASSET_KIND_MISMATCH");
        if (asset.status !== "ready") throw appError(404, "ASSET_NOT_FOUND");
      }
      for (const id of logos) {
        const asset = state.s2Assets.find((item) => item.id === id);
        if (!asset) throw appError(404, "ASSET_NOT_FOUND");
        if (asset.projectId !== projectId) throw appError(404, "ASSET_PROJECT_MISMATCH");
        if (asset.kind !== "logo") throw appError(409, "ASSET_KIND_MISMATCH");
        if (asset.status !== "ready") throw appError(404, "ASSET_NOT_FOUND");
      }
      if (arrayEqual(draft.referenceAssetIds, refs) && arrayEqual(draft.logoAssetIds, logos)) {
        this.rememberIdempotency(state, key, "s2_draft_update", projectId, inputHash, { draftId: draft.id });
        return { draft: cloneJson(draft), replayed: false };
      }
      draft.referenceAssetIds = refs.slice();
      draft.logoAssetIds = logos.slice();
      draft.revision += 1;
      draft.updatedAt = this.clock();
      this.rememberIdempotency(state, key, "s2_draft_update", projectId, inputHash, { draftId: draft.id });
      return { draft: cloneJson(draft), replayed: false };
    });
    const current = this.state();
    return { draft: publicDraft(current, result.draft), replayed: result.replayed };
  }

  private sourcePreparation(projectId: UUID, generationSetId: UUID): Promise<S2CandidateSource[]> {
    const state = this.state();
    this.s2Project(state, projectId);
    const set = state.generationSets.find((item) => item.generationSetId === generationSetId);
    if (!set || set.projectId !== projectId) throw appError(404, "GENERATION_SET_NOT_FOUND");
    if (set.status !== "succeeded") throw appError(409, "S2_NOT_AVAILABLE");
    const candidates = state.candidates.filter((item) => item.generationSetId === generationSetId)
      .sort((left, right) => left.candidateIndex - right.candidateIndex);
    if (candidates.length !== 4 || candidates.some((candidate, index) => candidate.candidateIndex !== index + 1)) throw appError(409, "QA_BINDING_CONFLICT");
    const project = state.projects.find((item) => item.projectId === projectId);
    return Promise.all(candidates.map(async (candidate) => {
      if (candidate.projectId !== projectId || candidate.confirmedBriefVersionId !== project?.confirmedBriefVersionId) throw appError(409, "QA_BINDING_CONFLICT");
      const asset = state.conceptAssets.find((item) => item.assetId === candidate.assetId);
      if (!asset || asset.projectId !== projectId || asset.generationSetId !== generationSetId || asset.status !== "stored" || asset.mimeType !== "image/png") throw appError(409, "QA_BINDING_CONFLICT");
      let bytes: Buffer;
      let measure: Awaited<ReturnType<typeof inspectCanonicalS1Png>>;
      try {
        bytes = this.objects.read(asset.storageKey);
        if (bytes.byteLength !== asset.byteSize || sha256(bytes) !== asset.sha256 || bytes.byteLength > SOURCE_PROVIDER_BYTES) throw new Error("source identity mismatch");
        measure = await inspectCanonicalS1Png(bytes);
      } catch {
        throw appError(409, "QA_BINDING_CONFLICT");
      }
      return {
        candidateId: candidate.candidateId,
        candidateIndex: candidate.candidateIndex,
        sourceAssetId: asset.assetId,
        sourceStorageKey: asset.storageKey,
        sourceSha256: asset.sha256,
        sourceByteSize: asset.byteSize,
        sourceWidth: measure.width,
        sourceHeight: measure.height,
        sourcePixelCount: measure.pixelCount,
        sourceDecodedRgbaBytes: measure.decodedRgbaBytes,
      };
    }));
  }

  private validateSelectedAssets(state: StoreState, draft: S2ReferenceDraft, sourceCandidates: readonly S2CandidateSource[]): void {
    const referenceIds = draft.referenceAssetIds;
    const logoIds = draft.logoAssetIds;
    if (new Set(referenceIds).size !== referenceIds.length || new Set(logoIds).size !== logoIds.length ||
        new Set([...referenceIds, ...logoIds]).size !== referenceIds.length + logoIds.length) {
      throw appError(409, "MEDIA_DUPLICATE");
    }
    if (referenceIds.length > S2_MAX_REFERENCES || logoIds.length > S2_MAX_LOGOS ||
        referenceIds.length + logoIds.length > S2_MAX_TOTAL_ASSETS) {
      throw appError(422, "DRAFT_LIMIT_EXCEEDED");
    }
    const measures = sourceCandidates.map((source) => ({
      encodedBytes: source.sourceByteSize,
      width: source.sourceWidth,
      height: source.sourceHeight,
      pixelCount: source.sourcePixelCount,
      decodedRgbaBytes: source.sourceDecodedRgbaBytes,
    }));
    const selected = [
      ...referenceIds.map((id) => ({ id, kind: "reference" as const })),
      ...logoIds.map((id) => ({ id, kind: "logo" as const })),
    ];
    for (const item of selected) {
      const asset = state.s2Assets.find((candidate) => candidate.id === item.id);
      if (!asset) throw appError(404, "ASSET_NOT_FOUND");
      if (asset.projectId !== draft.projectId) throw appError(404, "ASSET_PROJECT_MISMATCH");
      if (asset.kind !== item.kind) throw appError(409, "ASSET_KIND_MISMATCH");
      if (asset.status !== "ready") throw appError(404, "ASSET_NOT_FOUND");
      if (asset.pixelCount !== asset.width * asset.height) throw appError(409, "QA_BINDING_CONFLICT");
      const bytes = this.objects.read(asset.storageKeyNormalized);
      if (bytes.byteLength !== asset.normalizedBytes || sha256(bytes) !== asset.normalizedSha256) throw appError(409, "QA_BINDING_CONFLICT");
      measures.push({
        ...s2NormalizedMeasure({ normalizedBytes: bytes, width: asset.width, height: asset.height }),
        encodedBytes: bytes.byteLength,
      });
    }
    enforceS2AggregateLimits(measures, "assets", 4 + S2_MAX_TOTAL_ASSETS);
  }

  private inputManifest(state: StoreState, draft: S2ReferenceDraft, sources: readonly S2CandidateSource[]): {
    referenceAssets: Record<string, unknown>[];
    logoAssets: Record<string, unknown>[];
  } {
    return {
      referenceAssets: assetManifest(state, draft.referenceAssetIds),
      logoAssets: assetManifest(state, draft.logoAssetIds),
    };
  }

  async bindQa(
    projectId: UUID,
    sourceGenerationSetId: UUID,
    expectedDraftRevision: unknown,
    key: UUID,
    referenceId: UUID,
  ): Promise<S2Mutation<{ qaRun: S2QaRun; inputVersionId: UUID }>> {
    if (typeof expectedDraftRevision !== "number" || !Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 1) throw appError(400, "INVALID_REQUEST");
    const initialState = this.state();
    this.s2Project(initialState, projectId);
    const existingKey = initialState.idempotency.find((item) => item.key === key);
    if (existingKey) {
      if (existingKey.operation !== "s2_bind" || existingKey.projectId !== projectId) throw appError(409, "IDEMPOTENCY_KEY_REUSE");
      const existingInputId = typeof existingKey.result.inputVersionId === "string" ? existingKey.result.inputVersionId : null;
      const existingRunId = typeof existingKey.result.qaRunId === "string" ? existingKey.result.qaRunId : null;
      const existingInput = existingInputId ? initialState.s2Inputs.find((item) => item.id === existingInputId) : null;
      const existingRun = existingRunId ? initialState.s2QaRuns.find((item) => item.id === existingRunId) : null;
      if (!existingInput || !existingRun || existingInput.sourceGenerationSetId !== sourceGenerationSetId || existingInput.draftRevision !== expectedDraftRevision) {
        throw appError(409, "IDEMPOTENCY_KEY_REUSE");
      }
      return { qaRun: cloneJson(existingRun), inputVersionId: existingInput.id, replayed: true };
    }
    const sources = await this.sourcePreparation(projectId, sourceGenerationSetId);
    const result = this.repository.transact((state) => {
      this.s2Project(state, projectId);
      const currentProject = state.projects.find((item) => item.projectId === projectId)!;
      if (currentProject.activeGenerationSetId !== sourceGenerationSetId) throw appError(409, "QA_BINDING_CONFLICT");
      const confirmedBriefVersionId = currentProject.confirmedBriefVersionId;
      if (!confirmedBriefVersionId) throw appError(409, "S2_NOT_AVAILABLE");
      const briefVersion = state.briefVersions.find((item) => item.briefVersionId === confirmedBriefVersionId);
      if (!briefVersion || briefVersion.projectId !== projectId || briefVersion.status !== "confirmed") throw appError(409, "S2_NOT_AVAILABLE");
      const draft = this.draftIn(state, projectId, false);
      const rules = ruleSnapshot(briefVersion.geometrySnapshot);
      const requirements = requirementSnapshot(briefVersion.data, briefVersion.geometrySnapshot);
      const manifests = this.inputManifest(state, draft, sources);
      const geometryHash = sha256(jcs(briefVersion.geometrySnapshot));
      const requirementHash = sha256(jcs({ schemaVersion: "s2-requirements-v1", requirements }));
      const inputHash = sha256(jcs({
        schemaVersion: "s2-input-v1",
        sourceGenerationSetId,
        sourceCandidates: sources.map(sourceProjection),
        confirmedBriefVersionId: briefVersion.briefVersionId,
        confirmedBriefContentHash: briefVersion.contentHash,
        geometryHash,
        requirementHash,
        designRulesVersion: DESIGN_RULES_VERSION,
        designRuleSnapshot: rules,
        decoderProfile: DECODER_PROFILE,
        qaModel: S2_QA_MODEL,
        qaSchema: S2_QA_SCHEMA,
        referenceAssets: manifests.referenceAssets,
        logoAssets: manifests.logoAssets,
      }));
      const bindingHash = sha256(jcs({
        schemaVersion: "s2-binding-v1",
        projectId,
        sourceGenerationSetId,
        draftRevision: draft.revision,
        inputHash,
        sourceCandidates: sources.map(sourceProjection),
        referenceAssets: manifests.referenceAssets,
        logoAssets: manifests.logoAssets,
      }));
      const idempotencyHash = operationInputHash("s2_bind", projectId, {
        sourceGenerationSetId,
        expectedDraftRevision,
        bindingHash,
      });
      const existing = this.idempotencyIn(state, key, "s2_bind", projectId, idempotencyHash);
      if (existing) {
        return { inputVersionId: String(existing.result.inputVersionId), qaRunId: String(existing.result.qaRunId), replayed: true };
      }
      if (state.s2Inputs.some((item) => item.sourceGenerationSetId === sourceGenerationSetId) ||
          state.s2QaRuns.some((item) => item.sourceGenerationSetId === sourceGenerationSetId)) {
        throw appError(409, "S2_QA_RUN_EXISTS");
      }
      if (draft.status === "frozen") throw appError(409, "DRAFT_FROZEN");
      if (draft.revision !== expectedDraftRevision) throw appError(409, "DRAFT_REVISION_CONFLICT");
      const currentSet = state.generationSets.find((item) => item.generationSetId === sourceGenerationSetId);
      if (!currentSet || currentSet.projectId !== projectId || currentSet.status !== "succeeded") throw appError(409, "QA_BINDING_CONFLICT");
      const currentCandidates = state.candidates.filter((item) => item.generationSetId === sourceGenerationSetId)
        .sort((left, right) => left.candidateIndex - right.candidateIndex);
      if (currentCandidates.length !== 4 || currentCandidates.some((candidate, index) => candidate.candidateIndex !== index + 1 ||
          candidate.projectId !== projectId || candidate.generationSetId !== sourceGenerationSetId || candidate.confirmedBriefVersionId !== briefVersion.briefVersionId)) {
        throw appError(409, "QA_BINDING_CONFLICT");
      }
      for (let index = 0; index < currentCandidates.length; index += 1) {
        if (currentCandidates[index].candidateId !== sources[index].candidateId || currentCandidates[index].assetId !== sources[index].sourceAssetId) {
          throw appError(409, "QA_BINDING_CONFLICT");
        }
      }
      this.validateSelectedAssets(state, draft, sources);
      for (const source of sources) {
        const asset = state.conceptAssets.find((item) => item.assetId === source.sourceAssetId);
        if (!asset) throw appError(409, "QA_BINDING_CONFLICT");
        const bytes = this.objects.read(asset.storageKey);
        if (sha256(bytes) !== source.sourceSha256 || bytes.byteLength !== source.sourceByteSize) throw appError(409, "QA_BINDING_CONFLICT");
      }
      const inputVersionId = this.uuid();
      const qaRunId = this.uuid();
      const inputVersion: S2InputVersion = {
        id: inputVersionId,
        projectId,
        sourceGenerationSetId,
        sourceCandidates: cloneJson(sources),
        confirmedBriefVersionId: briefVersion.briefVersionId,
        confirmedBriefContentHash: briefVersion.contentHash,
        geometrySnapshot: cloneJson(briefVersion.geometrySnapshot),
        geometryHash,
        canonicalRequirements: cloneJson(requirements),
        requirementHash,
        designRulesVersion: DESIGN_RULES_VERSION,
        designRuleSnapshot: cloneJson(rules),
        decoderProfile: DECODER_PROFILE,
        qaModel: S2_QA_MODEL,
        qaSchema: S2_QA_SCHEMA,
        referenceAssetIds: draft.referenceAssetIds.slice(),
        logoAssetIds: draft.logoAssetIds.slice(),
        draftRevision: draft.revision,
        inputHash,
        bindingHash,
        status: "bound",
        createdAt: this.clock(),
        boundAt: this.clock(),
        qaRunId,
      };
      const candidateResults: S2QaCandidateResult[] = sources.map((source) => ({
        id: this.uuid(),
        qaRunId,
        inputVersionId,
        candidateId: source.candidateId,
        candidateIndex: source.candidateIndex,
        attempt: 1,
        sourceAssetId: source.sourceAssetId,
        sourceByteSize: source.sourceByteSize,
        sourceSha256: source.sourceSha256,
        status: "queued",
        verdict: "QA_UNAVAILABLE",
        requirementObservations: [],
        designObservations: [],
        materialFindingIds: [],
        warningFindingIds: [],
        uncertainFindingIds: [],
        providerRequestId: null,
        repairAttemptId: null,
        startedAt: null,
        completedAt: null,
      }));
      const run: S2QaRun = {
        id: qaRunId,
        projectId,
        inputVersionId,
        sourceGenerationSetId,
        status: "queued",
        candidateResults,
        completedCandidateCount: 0,
        passCount: 0,
        warningCount: 0,
        materialFailCount: 0,
        unavailableCount: 0,
        createdAt: this.clock(),
        startedAt: null,
        completedAt: null,
      };
      state.s2Inputs.push(inputVersion);
      state.s2QaRuns.push(run);
      draft.status = "frozen";
      draft.frozenAt = this.clock();
      draft.frozenByQaRunId = qaRunId;
      draft.updatedAt = this.clock();
      const operationIds: UUID[] = [];
      for (const result of candidateResults) {
        const operationId = this.uuid();
        operationIds.push(operationId);
        state.s2Operations.push({
          id: operationId,
          projectId,
          phase: "qa",
          attempt: 1,
          qaRunId,
          candidateId: result.candidateId,
          repairAttemptId: null,
          inputHash,
          referenceId,
          status: "queued",
          claimedBy: null,
          claimedProcessId: null,
          claimToken: null,
          claimedAt: null,
          startedAt: null,
          completedAt: null,
          failureCode: null,
          resultId: result.id,
        });
        this.transition(state, projectId, operationId, "qa", 1, "none", "queued", referenceId);
      }
      this.rememberIdempotency(state, key, "s2_bind", projectId, idempotencyHash, {
        inputVersionId,
        qaRunId,
        candidateResultIds: candidateResults.map((item) => item.id),
        operationIds,
        referenceId,
      });
      return { inputVersionId, qaRunId, qaRun: cloneJson(run), replayed: false };
    });
    if (!result.replayed) {
      for (const operation of this.state().s2Operations.filter((item) => item.qaRunId === result.qaRunId && item.phase === "qa")) this.startOperation(operation.id);
    }
    const current = this.state();
    const currentRun = current.s2QaRuns.find((item) => item.id === result.qaRunId);
    const run = result.replayed ? currentRun : result.qaRun;
    if (!run) throw appError(500, "PERSISTENCE_FAILED");
    return { qaRun: cloneJson(run), inputVersionId: result.inputVersionId, replayed: result.replayed };
  }

  getAsset(projectId: UUID, assetId: UUID): { bytes: Buffer; contentType: "image/png" } {
    const state = this.state();
    this.s2Project(state, projectId);
    const asset = state.s2Assets.find((item) => item.id === assetId);
    if (!asset) throw appError(404, "ASSET_NOT_FOUND");
    if (asset.projectId !== projectId) throw appError(404, "ASSET_PROJECT_MISMATCH");
    if (asset.status !== "ready") throw appError(404, "ASSET_NOT_FOUND");
    const bytes = this.objects.read(asset.storageKeyNormalized);
    if (bytes.byteLength !== asset.normalizedBytes || sha256(bytes) !== asset.normalizedSha256) throw appError(409, "QA_BINDING_CONFLICT");
    return { bytes, contentType: "image/png" };
  }

  private inputForRun(state: StoreState, run: S2QaRun): S2InputVersion {
    const input = state.s2Inputs.find((item) => item.id === run.inputVersionId);
    if (!input) throw appError(404, "S2_INPUT_NOT_FOUND");
    return input;
  }

  private latestResult(run: S2QaRun, candidateId: UUID): S2QaCandidateResult {
    const results = run.candidateResults.filter((item) => item.candidateId === candidateId).sort((left, right) => right.attempt - left.attempt);
    if (!results[0]) throw appError(404, "QA_NOT_FOUND");
    return results[0];
  }

  private publicRun(state: StoreState, run: S2QaRun): Record<string, unknown> {
    const input = this.inputForRun(state, run);
    const latest = Array.from(new Set(run.candidateResults.map((item) => item.candidateId)))
      .map((candidateId) => this.latestResult(run, candidateId))
      .sort((left, right) => left.candidateIndex - right.candidateIndex);
    const publicLatest = latest.map((result) => {
      let repairEligible = false;
      try {
        this.repairFindingIds(result, input);
        repairEligible = true;
      } catch {
        repairEligible = false;
      }
      return { ...cloneJson(result), repairEligible };
    });
    const attempts = cloneJson(run.candidateResults).sort((left, right) => left.candidateIndex - right.candidateIndex || left.attempt - right.attempt);
    return {
      qaRun: {
        ...cloneJson(run),
        candidateResults: publicLatest,
        candidateAttempts: attempts,
        repairs: state.s2Repairs.filter((item) => item.qaRunId === run.id).map((item) => ({
          id: item.id,
          candidateId: item.candidateId,
          attempt: item.attempt,
          status: item.status,
          eligibleFindingIds: item.eligibleFindingIds,
          outputSha256: item.outputSha256,
          derivedCandidateId: item.derivedCandidateId,
          reQaCandidateResultId: item.reQaCandidateResultId,
          providerRequestId: item.providerRequestId,
          createdAt: item.createdAt,
          startedAt: item.startedAt,
          completedAt: item.completedAt,
        })),
        reQa: state.s2ReQaResults.filter((item) => item.qaRunId === run.id).map((item) => cloneJson(item)),
      },
      input: {
        id: input.id,
        projectId: input.projectId,
        sourceGenerationSetId: input.sourceGenerationSetId,
        sourceCandidates: input.sourceCandidates.map(sourceProjection),
        confirmedBriefVersionId: input.confirmedBriefVersionId,
        confirmedBriefContentHash: input.confirmedBriefContentHash,
        geometrySnapshot: input.geometrySnapshot,
        geometryHash: input.geometryHash,
        canonicalRequirements: input.canonicalRequirements,
        requirementHash: input.requirementHash,
        designRulesVersion: input.designRulesVersion,
        designRuleSnapshot: input.designRuleSnapshot,
        decoderProfile: input.decoderProfile,
        qaModel: input.qaModel,
        qaSchema: input.qaSchema,
        referenceAssetIds: input.referenceAssetIds,
        logoAssetIds: input.logoAssetIds,
        draftRevision: input.draftRevision,
        inputHash: input.inputHash,
        bindingHash: input.bindingHash,
      },
    };
  }

  getQaRun(projectId: UUID, qaRunId: UUID): Record<string, unknown> {
    const state = this.state();
    this.s2Project(state, projectId);
    const run = state.s2QaRuns.find((item) => item.id === qaRunId);
    if (!run || run.projectId !== projectId) throw appError(404, "QA_NOT_FOUND");
    return this.publicRun(state, run);
  }

  private transition(state: StoreState, projectId: UUID, operationId: UUID, phase: S2Operation["phase"], attempt: 1 | 2, from: string, to: string, referenceId: UUID): void {
    state.s2Transitions.push({
      id: this.uuid(),
      projectId,
      operationId,
      phase,
      attempt,
      from,
      to,
      referenceId,
      at: this.clock(),
    });
  }

  private startOperation(operationId: UUID): void {
    const key = S2_OPERATION_PREFIX + operationId;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    void this.runOperation(operationId).catch(() => undefined).finally(() => this.inFlight.delete(key));
  }

  private runOperation(operationId: UUID): Promise<void> {
    const state = this.state();
    const operation = state.s2Operations.find((item) => item.id === operationId);
    if (!operation) return Promise.resolve();
    if (operation.phase === "qa") return this.runQaOperation(operationId);
    if (operation.phase === "repair") return this.runRepairOperation(operationId);
    return this.runReQaOperation(operationId);
  }

  private claimOperation(operationId: UUID): { operation: S2Operation; token: UUID } | null {
    return this.repository.transact((state) => {
      const operation = state.s2Operations.find((item) => item.id === operationId);
      if (!operation || operation.status !== "queued") return null;
      const token = this.uuid();
      operation.status = "running";
      operation.claimedBy = this.workerId;
      operation.claimedProcessId = this.processId;
      operation.claimToken = token;
      operation.claimedAt = this.clock();
      operation.startedAt = this.clock();
      const run = state.s2QaRuns.find((item) => item.id === operation.qaRunId);
      if (run) {
        run.status = "running";
        run.startedAt ??= this.clock();
        if (operation.phase === "qa") {
          const result = run.candidateResults.find((item) => item.id === operation.resultId);
          if (result) {
            result.status = "running";
            result.startedAt = this.clock();
            this.transition(state, operation.projectId, operation.id, operation.phase, operation.attempt, "queued", "running", operation.referenceId);
          }
        }
      }
      if (operation.phase === "repair" && operation.repairAttemptId) {
        const repair = state.s2Repairs.find((item) => item.id === operation.repairAttemptId);
        if (repair) {
          repair.status = "running";
          repair.startedAt = this.clock();
          this.transition(state, operation.projectId, operation.id, operation.phase, operation.attempt, "queued", "running", operation.referenceId);
        }
      }
      if (operation.phase === "re_qa" && operation.repairAttemptId) {
        const repair = state.s2Repairs.find((item) => item.id === operation.repairAttemptId);
        const result = state.s2ReQaResults.find((item) => item.id === operation.resultId);
        if (repair) repair.status = "re_qa_running";
        if (result) {
          result.status = "running";
          result.startedAt = this.clock();
          this.transition(state, operation.projectId, operation.id, operation.phase, operation.attempt, "queued", "running", operation.referenceId);
        }
      }
      return { operation: cloneJson(operation), token };
    });
  }

  private readSource(input: S2InputVersion, candidateId: UUID): Buffer {
    const source = input.sourceCandidates.find((item) => item.candidateId === candidateId);
    if (!source) throw appError(409, "QA_BINDING_CONFLICT");
    const bytes = this.objects.read(source.sourceStorageKey);
    if (bytes.byteLength !== source.sourceByteSize || sha256(bytes) !== source.sourceSha256) throw appError(409, "QA_BINDING_CONFLICT");
    return bytes;
  }

  private qaInput(input: S2InputVersion, candidateId: UUID, bytes: Uint8Array): S2QaProviderInput {
    const source = input.sourceCandidates.find((item) => item.candidateId === candidateId);
    if (!source) throw appError(409, "QA_BINDING_CONFLICT");
    return {
      sourceBytes: bytes,
      candidateId,
      candidateIndex: source.candidateIndex,
      geometrySnapshot: input.geometrySnapshot,
      requirements: input.canonicalRequirements,
      designRules: input.designRuleSnapshot.filter((rule) => rule.applicability === "applicable"),
    };
  }

  private async runQaOperation(operationId: UUID): Promise<void> {
    const claim = this.claimOperation(operationId);
    if (!claim) return;
    const operation = claim.operation;
    try {
      const state = this.state();
      const run = state.s2QaRuns.find((item) => item.id === operation.qaRunId);
      if (!run) throw appError(500, "PERSISTENCE_FAILED");
      const input = this.inputForRun(state, run);
      const bytes = this.readSource(input, operation.candidateId);
      if (!this.provider.runS2Qa) throw new ProviderFailure("PROVIDER_NOT_CONFIGURED");
      const response = await this.provider.runS2Qa(this.qaInput(input, operation.candidateId, bytes));
      const validated = validateProviderObservation(response.payload, input);
      const evaluated = evaluateObservations(validated, input);
      this.repository.transact((current) => {
        const stored = current.s2Operations.find((item) => item.id === operationId);
        if (!stored || !this.claimMatches(stored, claim.token)) return;
        const storedRun = current.s2QaRuns.find((item) => item.id === stored.qaRunId);
        const result = storedRun?.candidateResults.find((item) => item.id === stored.resultId);
        if (!storedRun || !result || result.status !== "running") return;
        result.status = evaluated.verdict === "PASS" ? "pass" : evaluated.verdict === "WARNING" ? "warning" : "material_fail";
        result.verdict = evaluated.verdict;
        result.requirementObservations = evaluated.requirements;
        result.designObservations = evaluated.designRules;
        result.materialFindingIds = evaluated.materialFindingIds;
        result.warningFindingIds = evaluated.warningFindingIds;
        result.uncertainFindingIds = evaluated.uncertainFindingIds;
        result.providerRequestId = safeProviderRequestId(response.providerRequestId);
        result.completedAt = this.clock();
        stored.status = "succeeded";
        stored.completedAt = this.clock();
        stored.failureCode = null;
        this.clearClaim(stored);
        this.transition(current, stored.projectId, stored.id, stored.phase, stored.attempt, "running", result.status, stored.referenceId);
        this.recomputeRun(storedRun);
      });
    } catch (error) {
      this.failQaOperation(operationId, claim.token, error);
    }
  }

  private failQaOperation(operationId: UUID, token: UUID, error: unknown): void {
    const failureCode = error instanceof AppError
      ? error.code
      : error instanceof ProviderFailure
        ? error.safeCode === "QA_SCHEMA_INVALID" ? "QA_SCHEMA_INVALID" : "QA_PROVIDER_FAILED"
        : "QA_PROVIDER_FAILED";
    try {
      this.repository.transact((state) => {
        const operation = state.s2Operations.find((item) => item.id === operationId);
        if (!operation || !this.claimMatches(operation, token)) return;
        const run = state.s2QaRuns.find((item) => item.id === operation.qaRunId);
        const result = run?.candidateResults.find((item) => item.id === operation.resultId);
        if (!run || !result || result.status !== "running") return;
        const retry = retryableFailure(error) && operation.attempt === 1;
        result.status = retry ? "qa_unavailable_retryable" : "qa_unavailable_terminal";
        result.verdict = "QA_UNAVAILABLE";
        result.completedAt = this.clock();
        operation.status = "failed";
        operation.failureCode = failureCode;
        operation.completedAt = this.clock();
        this.clearClaim(operation);
        this.transition(state, operation.projectId, operation.id, operation.phase, operation.attempt, "running", result.status, operation.referenceId);
        this.recomputeRun(run);
      });
    } catch {
      // The persisted claim remains authoritative; no success is fabricated.
    }
  }

  private recomputeRun(run: S2QaRun): void {
    const latest = Array.from(new Set(run.candidateResults.map((item) => item.candidateId)))
      .map((candidateId) => this.latestResult(run, candidateId));
    run.completedCandidateCount = latest.filter((item) => isTerminalCandidate(item.status)).length;
    run.passCount = latest.filter((item) => item.status === "pass").length;
    run.warningCount = latest.filter((item) => item.status === "warning").length;
    run.materialFailCount = latest.filter((item) => item.status === "material_fail").length;
    run.unavailableCount = latest.filter((item) => item.status === "qa_unavailable_retryable" || item.status === "qa_unavailable_terminal").length;
    if (latest.length === 4 && latest.every((item) => isTerminalCandidate(item.status))) {
      run.status = "completed";
      run.completedAt = this.clock();
    } else if (run.status !== "failed") {
      run.status = "running";
      run.completedAt = null;
    }
  }

  async retryQa(projectId: UUID, qaRunId: UUID, candidateId: UUID, key: UUID, referenceId: UUID): Promise<S2Mutation<Record<string, unknown>>> {
    const result = this.repository.transact((state) => {
      this.s2Project(state, projectId);
      const run = state.s2QaRuns.find((item) => item.id === qaRunId);
      if (!run || run.projectId !== projectId) throw appError(404, "QA_NOT_FOUND");
      const current = this.latestResult(run, candidateId);
      const inputHash = operationInputHash("s2_qa_retry", projectId, { qaRunId, candidateId, expectedAttempt: 1 });
      const existing = this.idempotencyIn(state, key, "s2_qa_retry", projectId, inputHash);
      if (existing) return { replayed: true };
      if (current.status !== "qa_unavailable_retryable") throw appError(409, run.candidateResults.some((item) => item.candidateId === candidateId && item.attempt === 2) ? "QA_RETRY_EXHAUSTED" : "QA_NOT_RETRYABLE");
      if (run.candidateResults.some((item) => item.candidateId === candidateId && item.attempt === 2)) throw appError(409, "QA_RETRY_EXHAUSTED");
      const input = this.inputForRun(state, run);
      const source = input.sourceCandidates.find((item) => item.candidateId === candidateId);
      if (!source || source.sourceSha256 !== current.sourceSha256 || source.sourceByteSize !== current.sourceByteSize) throw appError(409, "QA_BINDING_CONFLICT");
      const retryResult: S2QaCandidateResult = {
        ...cloneJson(current),
        id: this.uuid(),
        attempt: 2,
        status: "queued",
        verdict: "QA_UNAVAILABLE",
        requirementObservations: [],
        designObservations: [],
        materialFindingIds: [],
        warningFindingIds: [],
        uncertainFindingIds: [],
        providerRequestId: null,
        repairAttemptId: null,
        startedAt: null,
        completedAt: null,
      };
      const operationId = this.uuid();
      run.candidateResults.push(retryResult);
      run.status = "queued";
      run.completedAt = null;
      state.s2Operations.push({
        id: operationId,
        projectId,
        phase: "qa",
        attempt: 2,
        qaRunId,
        candidateId,
        repairAttemptId: null,
        inputHash: input.inputHash,
        referenceId,
        status: "queued",
        claimedBy: null,
        claimedProcessId: null,
        claimToken: null,
        claimedAt: null,
        startedAt: null,
        completedAt: null,
        failureCode: null,
        resultId: retryResult.id,
      });
      this.transition(state, projectId, operationId, "qa", 2, current.status, "queued", referenceId);
      this.rememberIdempotency(state, key, "s2_qa_retry", projectId, inputHash, { qaRunId, candidateId, resultId: retryResult.id, operationId });
      return { replayed: false };
    });
    if (!result.replayed) {
      const operation = this.state().s2Operations.find((item) => item.qaRunId === qaRunId && item.candidateId === candidateId && item.attempt === 2 && item.phase === "qa");
      if (operation) this.startOperation(operation.id);
    }
    return { ...this.getQaRun(projectId, qaRunId), replayed: result.replayed };
  }

  private repairFindingIds(result: S2QaCandidateResult, input: S2InputVersion): string[] {
    if (result.status !== "material_fail" || result.verdict !== "MATERIAL_FAIL" || result.uncertainFindingIds.length) {
      throw appError(409, "REPAIR_NOT_ELIGIBLE");
    }
    const ids = orderedFindingIds(result.materialFindingIds);
    if (!compatibleFindingSet(ids)) throw appError(409, "REPAIR_NOT_ELIGIBLE");
    const ruleMap = new Map(input.designRuleSnapshot.map((rule) => [rule.ruleId, rule]));
    for (const id of ids) {
      const requirement = input.canonicalRequirements.find((item) => item.requirementId === id);
      const rule = ruleMap.get(id);
      if (id.startsWith("brief.functional.") && (!requirement || requirement.category !== "functional")) throw appError(409, "REPAIR_NOT_ELIGIBLE");
      if (id.startsWith("brief.mandatory.") && (!requirement || requirement.category !== "mandatory")) throw appError(409, "REPAIR_NOT_ELIGIBLE");
      if (!requirement && !rule) throw appError(409, "REPAIR_NOT_ELIGIBLE");
      if (requirement && requirement.criticality !== "material") throw appError(409, "REPAIR_NOT_ELIGIBLE");
      if (rule && (!rule.repairable || rule.applicability !== "applicable")) throw appError(409, "REPAIR_NOT_ELIGIBLE");
    }
    return ids;
  }

  private repairManifests(state: StoreState, input: S2InputVersion, candidateId: UUID): {
    refs: Record<string, unknown>[];
    logos: Record<string, unknown>[];
    images: Buffer[];
    manifestHash: Sha256;
  } {
    const source = input.sourceCandidates.find((item) => item.candidateId === candidateId);
    if (!source) throw appError(409, "QA_BINDING_CONFLICT");
    const refs: Record<string, unknown>[] = [];
    const logos: Record<string, unknown>[] = [];
    const images: Buffer[] = [this.readSource(input, candidateId)];
    const measures = [{
      encodedBytes: images[0].byteLength,
      width: source.sourceWidth,
      height: source.sourceHeight,
      pixelCount: source.sourcePixelCount,
      decodedRgbaBytes: source.sourceDecodedRgbaBytes,
    }];
    const appendAsset = (id: UUID, kind: "reference" | "logo", slot: number): void => {
      const asset = state.s2Assets.find((item) => item.id === id);
      if (!asset || asset.status !== "ready" || asset.kind !== kind || asset.pixelCount !== asset.width * asset.height) {
        throw appError(409, "QA_BINDING_CONFLICT");
      }
      let bytes: Buffer;
      try {
        bytes = this.objects.read(asset.storageKeyNormalized);
      } catch {
        throw appError(409, "QA_BINDING_CONFLICT");
      }
      if (bytes.byteLength !== asset.normalizedBytes || sha256(bytes) !== asset.normalizedSha256) {
        throw appError(409, "QA_BINDING_CONFLICT");
      }
      const manifest = {
        assetId: id,
        normalizedSha256: asset.normalizedSha256,
        width: asset.width,
        height: asset.height,
        normalizedBytes: asset.normalizedBytes,
        slot,
      };
      if (kind === "reference") refs.push(manifest);
      else logos.push(manifest);
      images.push(bytes);
      measures.push({
        ...s2NormalizedMeasure({ normalizedBytes: bytes, width: asset.width, height: asset.height }),
        encodedBytes: bytes.byteLength,
      });
    };
    input.referenceAssetIds.forEach((id, index) => appendAsset(id, "reference", index + 1));
    input.logoAssetIds.forEach((id, index) => appendAsset(id, "logo", index + 1));
    if (images.length > S2_MAX_REPAIR_IMAGES) throw appError(422, "MEDIA_AGGREGATE_LIMIT_EXCEEDED");
    enforceS2AggregateLimits(measures, "assets", S2_MAX_REPAIR_IMAGES);
    return { refs, logos, images, manifestHash: repairManifestHash(refs, logos) };
  }
  async repairCandidate(projectId: UUID, qaRunId: UUID, candidateId: UUID, expectedInputVersionId: unknown, key: UUID, referenceId: UUID): Promise<S2Mutation<Record<string, unknown>>> {
    if (typeof expectedInputVersionId !== "string") throw appError(400, "INVALID_REQUEST");
    const result = this.repository.transact((state) => {
      this.s2Project(state, projectId);
      const run = state.s2QaRuns.find((item) => item.id === qaRunId);
      if (!run || run.projectId !== projectId) throw appError(404, "QA_NOT_FOUND");
      const input = this.inputForRun(state, run);
      if (input.id !== expectedInputVersionId) throw appError(409, "QA_BINDING_CONFLICT");
      const current = this.latestResult(run, candidateId);
      const source = input.sourceCandidates.find((item) => item.candidateId === candidateId);
      if (!source || current.sourceAssetId !== source.sourceAssetId || current.sourceSha256 !== source.sourceSha256 || current.sourceByteSize !== source.sourceByteSize) {
        throw appError(409, "QA_BINDING_CONFLICT");
      }
      const findingIds = this.repairFindingIds(current, input);
      const manifest = this.repairManifests(state, input, candidateId);
      const inputHash = sha256(jcs({
        schemaVersion: "s2-repair-v1",
        inputVersionId: input.id,
        qaRunId,
        candidateId,
        sourceAssetId: source.sourceAssetId,
        sourceSha256: source.sourceSha256,
        sourceByteSize: source.sourceByteSize,
        sourceWidth: source.sourceWidth,
        sourceHeight: source.sourceHeight,
        sourcePixelCount: source.sourcePixelCount,
        sourceDecodedRgbaBytes: source.sourceDecodedRgbaBytes,
        bindingHash: input.bindingHash,
        orderedFindingIds: findingIds,
        referenceAssets: manifest.refs,
        logoAssets: manifest.logos,
        confirmedBriefContentHash: input.confirmedBriefContentHash,
        geometryHash: input.geometryHash,
        attempt: 1,
      }));
      const idempotencyHash = operationInputHash("s2_repair", projectId, {
        qaRunId,
        candidateId,
        expectedInputVersionId,
        eligibleFindingIds: findingIds,
      });
      const existing = this.idempotencyIn(state, key, "s2_repair", projectId, idempotencyHash);
      if (existing) return { repairAttemptId: String(existing.result.repairAttemptId), replayed: true };
      if (state.s2Repairs.some((item) => item.qaRunId === qaRunId && item.candidateId === candidateId)) throw appError(409, "REPAIR_ALREADY_EXISTS");
      const repairAttemptId = this.uuid();
      const prompt = renderRepairPrompt(input, source, findingIds, manifest.manifestHash);
      const attempt: S2RepairAttempt = {
        id: repairAttemptId,
        projectId,
        qaRunId,
        inputVersionId: input.id,
        candidateId,
        attempt: 1,
        status: "queued",
        eligibleFindingIds: findingIds,
        sourceAssetId: current.sourceAssetId,
        sourceByteSize: current.sourceByteSize,
        sourceSha256: current.sourceSha256,
        repairInputHash: inputHash,
        repairPromptHash: sha256(Buffer.from(prompt, "utf8")),
        outputSha256: null,
        derivedCandidateId: null,
        reQaCandidateResultId: null,
        providerRequestId: null,
        createdAt: this.clock(),
        startedAt: null,
        completedAt: null,
      };
      const operationId = this.uuid();
      state.s2Repairs.push(attempt);
      current.repairAttemptId = repairAttemptId;
      state.s2Operations.push({
        id: operationId,
        projectId,
        phase: "repair",
        attempt: 1,
        qaRunId,
        candidateId,
        repairAttemptId,
        inputHash,
        referenceId,
        status: "queued",
        claimedBy: null,
        claimedProcessId: null,
        claimToken: null,
        claimedAt: null,
        startedAt: null,
        completedAt: null,
        failureCode: null,
        resultId: null,
      });
      this.transition(state, projectId, operationId, "repair", 1, "eligible", "queued", referenceId);
      this.rememberIdempotency(state, key, "s2_repair", projectId, idempotencyHash, { repairAttemptId, operationId });
      return { repairAttemptId, replayed: false };
    });
    if (!result.replayed) {
      const operation = this.state().s2Operations.find((item) => item.repairAttemptId === result.repairAttemptId && item.phase === "repair");
      if (operation) this.startOperation(operation.id);
    }
    return { ...this.getQaRun(projectId, qaRunId), replayed: result.replayed };
  }

  private async runRepairOperation(operationId: UUID): Promise<void> {
    const claim = this.claimOperation(operationId);
    if (!claim) return;
    const operation = claim.operation;
    let stageKey: string | null = null;
    let finalKey: string | null = null;
    let publication: S2RepairPublication | null = null;
    try {
      const state = this.state();
      const repair = state.s2Repairs.find((item) => item.id === operation.repairAttemptId);
      const run = state.s2QaRuns.find((item) => item.id === operation.qaRunId);
      if (!repair || !run) throw appError(500, "PERSISTENCE_FAILED");
      const input = this.inputForRun(state, run);
      const manifest = this.repairManifests(state, input, operation.candidateId);
      const source = input.sourceCandidates.find((item) => item.candidateId === operation.candidateId);
      if (!source) throw appError(409, "QA_BINDING_CONFLICT");
      stageKey = privateStorageKey("projects", operation.projectId, "s2", "repairs", repair.id, "staged", "provider-output.png");
      finalKey = privateStorageKey("projects", operation.projectId, "s2", "repairs", repair.id, "output.png");
      if (!this.provider.runS2Repair) throw new ProviderFailure("PROVIDER_NOT_CONFIGURED");
      const providerInput: S2RepairProviderInput = {
        promptText: renderRepairPrompt(input, source, repair.eligibleFindingIds, manifest.manifestHash),
        images: manifest.images,
      };
      const response = await this.provider.runS2Repair(providerInput);
      assertS2Png(response.pngBytes, S2_MAX_REPAIR_OUTPUT_BYTES);
      this.objects.put(stageKey, response.pngBytes);
      this.verifyObject(stageKey, response.pngBytes.byteLength, sha256(response.pngBytes));
      let normalized;
      try {
        const raw = this.objects.read(stageKey);
        normalized = await normalizeS2Media({
          kind: "reference",
          fileName: "provider-output.png",
          mimeType: "image/png",
          bytes: raw,
          maxInputBytes: S2_MAX_REPAIR_OUTPUT_BYTES,
        });
      } catch (error) {
        if (error instanceof AppError && error.code === "REPAIR_OUTPUT_INVALID") throw error;
        throw new AppError(422, "REPAIR_OUTPUT_INVALID");
      }
      this.objects.remove(stageKey);
      this.objects.put(stageKey, normalized.normalizedBytes);
      this.verifyObject(stageKey, normalized.normalizedBytes.byteLength, normalized.normalizedSha256);
      const derivedId = this.uuid();
      const reQaResultId = this.uuid();
      const reQaOperationId = this.uuid();
      const sourceCandidate = source;
      const derived: S2DerivedCandidate = {
        id: derivedId,
        projectId: operation.projectId,
        sourceGenerationSetId: input.sourceGenerationSetId,
        inputVersionId: input.id,
        qaRunId: run.id,
        sourceCandidateId: operation.candidateId,
        repairAttemptId: repair.id,
        sourceAssetId: sourceCandidate.sourceAssetId,
        sourceByteSize: sourceCandidate.sourceByteSize,
        sourceSha256: sourceCandidate.sourceSha256,
        outputSha256: normalized.normalizedSha256,
        normalizedBytes: normalized.normalizedBytes.byteLength,
        width: normalized.width,
        height: normalized.height,
        storageKeyNormalized: finalKey,
        createdAt: this.clock(),
      };
      const reQa: S2ReQaResult = {
        id: reQaResultId,
        qaRunId: run.id,
        inputVersionId: input.id,
        candidateId: operation.candidateId,
        candidateIndex: sourceCandidate.candidateIndex,
        attempt: 1,
        sourceAssetId: sourceCandidate.sourceAssetId,
        sourceByteSize: sourceCandidate.sourceByteSize,
        sourceSha256: sourceCandidate.sourceSha256,
        status: "queued",
        verdict: "QA_UNAVAILABLE",
        requirementObservations: [],
        designObservations: [],
        materialFindingIds: [],
        warningFindingIds: [],
        uncertainFindingIds: [],
        providerRequestId: null,
        repairAttemptId: repair.id,
        startedAt: null,
        completedAt: null,
        phase: "re_qa",
        derivedCandidateId: derivedId,
      };
      const reQaOperation: S2Operation = {
        id: reQaOperationId,
        projectId: operation.projectId,
        phase: "re_qa",
        attempt: 1,
        qaRunId: run.id,
        candidateId: operation.candidateId,
        repairAttemptId: repair.id,
        inputHash: input.inputHash,
        referenceId: operation.referenceId,
        status: "queued",
        claimedBy: null,
        claimedProcessId: null,
        claimToken: null,
        claimedAt: null,
        startedAt: null,
        completedAt: null,
        failureCode: null,
        resultId: reQaResultId,
      };
      publication = {
        kind: "repair_output",
        id: this.uuid(),
        projectId: operation.projectId,
        operationId,
        repairAttemptId: repair.id,
        qaRunId: run.id,
        candidateId: operation.candidateId,
        inputVersionId: input.id,
        inputHash: input.inputHash,
        stagingObjects: [{ key: stageKey, sha256: normalized.normalizedSha256, byteSize: normalized.normalizedBytes.byteLength }],
        finalObjects: [{ key: finalKey, sha256: normalized.normalizedSha256, byteSize: normalized.normalizedBytes.byteLength }],
        intendedDerived: derived,
        intendedReQa: reQa,
        intendedReQaOperation: reQaOperation,
        providerRequestId: safeProviderRequestId(response.providerRequestId),
        state: "staged",
        createdAt: this.clock(),
        updatedAt: this.clock(),
      };
      const repairPublication = publication;
      this.repository.transact((current) => {
        const stored = current.s2Operations.find((item) => item.id === operationId);
        if (!stored || !this.claimMatches(stored, claim.token)) throw appError(409, "STATE_CONFLICT");
        current.s2Publications.push(cloneJson(repairPublication));
      });
      this.objects.promote(stageKey, finalKey);
      this.verifyObject(finalKey, normalized.normalizedBytes.byteLength, normalized.normalizedSha256);
      this.markPublicationState(repairPublication.id, "promoted");
      this.notifyPublicationPromoted(repairPublication);
      const committed = this.repository.transact((current) => {
        const stored = current.s2Operations.find((item) => item.id === operationId);
        if (!stored || !this.claimMatches(stored, claim.token)) {
          return false;
        }
        const storedPublication = current.s2Publications.find((item) => item.id === repairPublication.id);
        if (!storedPublication || storedPublication.kind !== "repair_output" || storedPublication.state !== "promoted") throw appError(500, "PERSISTENCE_FAILED");
        const storedRepair = current.s2Repairs.find((item) => item.id === repair.id);
        if (!storedRepair) throw appError(500, "PERSISTENCE_FAILED");
        current.s2DerivedCandidates.push(cloneJson(storedPublication.intendedDerived));
        current.s2ReQaResults.push(cloneJson(storedPublication.intendedReQa));
        storedRepair.status = "derived_ready";
        storedRepair.outputSha256 = storedPublication.intendedDerived.outputSha256;
        storedRepair.derivedCandidateId = storedPublication.intendedDerived.id;
        storedRepair.reQaCandidateResultId = storedPublication.intendedReQa.id;
        storedRepair.providerRequestId = storedPublication.providerRequestId;
        storedRepair.completedAt = this.clock();
        stored.status = "succeeded";
        stored.completedAt = this.clock();
        this.clearClaim(stored);
        this.transition(current, stored.projectId, stored.id, stored.phase, 1, "running", "derived_ready", stored.referenceId);
        current.s2Operations.push(cloneJson(storedPublication.intendedReQaOperation));
        this.transition(current, stored.projectId, storedPublication.intendedReQaOperation.id, "re_qa", 1, "derived_ready", "queued", stored.referenceId);
        storedPublication.state = "committed";
        storedPublication.updatedAt = this.clock();
        return true;
      });
      if (!committed) {
        this.cleanupPublicationObjects(repairPublication, true);
        return;
      }
      this.cleanupPublicationObjects(repairPublication, false);
      const storedReQaOperation = this.state().s2Operations.find((item) => item.id === reQaOperationId);
      if (storedReQaOperation) this.startOperation(storedReQaOperation.id);
    } catch (error) {
      if (error instanceof SimulatedProcessInterruption) throw error;
      if (stageKey) this.objects.remove(stageKey);
      if (publication) {
        this.cleanupPublicationObjects(publication, true);
        try {
          this.markPublicationState(publication.id, "aborted");
        } catch {
          // Recovery will reconcile a durable publication record if the abort write fails.
        }
      } else if (finalKey) this.objects.remove(finalKey);
      this.failRepairOperation(operationId, claim.token, error);
    }
  }

  private failRepairOperation(operationId: UUID, token: UUID, error: unknown): void {
    const code = error instanceof AppError
      ? error.code
      : error instanceof ProviderFailure
        ? error.safeCode === "REPAIR_OUTPUT_INVALID" ? "REPAIR_OUTPUT_INVALID" : "REPAIR_PROVIDER_FAILED"
        : "REPAIR_PROVIDER_FAILED";
    try {
      this.repository.transact((state) => {
        const operation = state.s2Operations.find((item) => item.id === operationId);
        if (!operation || !this.claimMatches(operation, token)) return;
        const repair = operation.repairAttemptId ? state.s2Repairs.find((item) => item.id === operation.repairAttemptId) : null;
        if (repair) {
          repair.status = "failed";
          repair.completedAt = this.clock();
        }
        operation.status = "failed";
        operation.failureCode = code;
        operation.completedAt = this.clock();
        this.clearClaim(operation);
        this.transition(state, operation.projectId, operation.id, "repair", 1, "running", "failed", operation.referenceId);
      });
    } catch {
      // Keep the operation fenced; no derived success is fabricated.
    }
  }

  private async runReQaOperation(operationId: UUID): Promise<void> {
    const claim = this.claimOperation(operationId);
    if (!claim) return;
    const operation = claim.operation;
    try {
      const state = this.state();
      const repair = state.s2Repairs.find((item) => item.id === operation.repairAttemptId);
      const derived = repair?.derivedCandidateId ? state.s2DerivedCandidates.find((item) => item.id === repair.derivedCandidateId) : null;
      const run = state.s2QaRuns.find((item) => item.id === operation.qaRunId);
      const result = state.s2ReQaResults.find((item) => item.id === operation.resultId);
      if (!repair || !derived || !run || !result) throw appError(500, "PERSISTENCE_FAILED");
      const input = this.inputForRun(state, run);
      const bytes = this.objects.read(derived.storageKeyNormalized);
      if (bytes.byteLength !== derived.normalizedBytes || sha256(bytes) !== derived.outputSha256) throw appError(503, "RE_QA_UNAVAILABLE");
      if (!this.provider.runS2Qa) throw new ProviderFailure("PROVIDER_NOT_CONFIGURED");
      const response = await this.provider.runS2Qa(this.qaInput(input, operation.candidateId, bytes));
      const evaluated = evaluateObservations(validateProviderObservation(response.payload, input), input);
      this.repository.transact((current) => {
        const stored = current.s2Operations.find((item) => item.id === operationId);
        if (!stored || !this.claimMatches(stored, claim.token)) return;
        const storedResult = current.s2ReQaResults.find((item) => item.id === stored.resultId);
        const storedRepair = stored.repairAttemptId ? current.s2Repairs.find((item) => item.id === stored.repairAttemptId) : null;
        if (!storedResult || !storedRepair) return;
        storedResult.status = evaluated.verdict === "PASS" ? "pass" : evaluated.verdict === "WARNING" ? "warning" : "material_fail";
        storedResult.verdict = evaluated.verdict;
        storedResult.requirementObservations = evaluated.requirements;
        storedResult.designObservations = evaluated.designRules;
        storedResult.materialFindingIds = evaluated.materialFindingIds;
        storedResult.warningFindingIds = evaluated.warningFindingIds;
        storedResult.uncertainFindingIds = evaluated.uncertainFindingIds;
        storedResult.providerRequestId = safeProviderRequestId(response.providerRequestId);
        storedResult.completedAt = this.clock();
        storedRepair.status = evaluated.verdict === "PASS" ? "re_qa_pass" : evaluated.verdict === "WARNING" ? "re_qa_warning" : "re_qa_material_fail";
        storedRepair.completedAt = this.clock();
        stored.status = "succeeded";
        stored.completedAt = this.clock();
        this.clearClaim(stored);
        this.transition(current, stored.projectId, stored.id, "re_qa", 1, "running", storedResult.status, stored.referenceId);
      });
    } catch (error) {
      this.failReQaOperation(operationId, claim.token, error);
    }
  }

  private failReQaOperation(operationId: UUID, token: UUID, error: unknown): void {
    const code = "RE_QA_UNAVAILABLE";
    try {
      this.repository.transact((state) => {
        const operation = state.s2Operations.find((item) => item.id === operationId);
        if (!operation || !this.claimMatches(operation, token)) return;
        const result = state.s2ReQaResults.find((item) => item.id === operation.resultId);
        const repair = operation.repairAttemptId ? state.s2Repairs.find((item) => item.id === operation.repairAttemptId) : null;
        if (result) {
          result.status = "re_qa_unavailable";
          result.verdict = "QA_UNAVAILABLE";
          result.completedAt = this.clock();
        }
        if (repair) {
          repair.status = "re_qa_unavailable";
          repair.completedAt = this.clock();
        }
        operation.status = "failed";
        operation.failureCode = code;
        operation.completedAt = this.clock();
        this.clearClaim(operation);
        this.transition(state, operation.projectId, operation.id, "re_qa", 1, "running", "re_qa_unavailable", operation.referenceId);
      });
    } catch {
      // Keep the failure boundary conservative.
    }
  }

  private recoverPendingOperations(): void {
    const queued = this.repository.transact((state) => {
      const ids: UUID[] = [];
      for (const operation of state.s2Operations) {
        if (!isPending(operation.status)) continue;
        if (operation.status === "running" && this.claimIsLive(operation)) continue;
        const wasRunning = operation.status === "running";
        const run = state.s2QaRuns.find((item) => item.id === operation.qaRunId);
        if (wasRunning && operation.phase === "qa") {
          const result = run?.candidateResults.find((item) => item.id === operation.resultId);
          if (result?.status === "running") {
            result.status = "queued";
            result.startedAt = null;
            result.completedAt = null;
            this.transition(state, operation.projectId, operation.id, operation.phase, operation.attempt, "running", "queued", operation.referenceId);
          }
          if (run) {
            run.status = "queued";
            run.completedAt = null;
          }
        } else if (wasRunning && operation.phase === "repair" && operation.repairAttemptId) {
          const repair = state.s2Repairs.find((item) => item.id === operation.repairAttemptId);
          if (repair?.status === "running") {
            repair.status = "queued";
            repair.startedAt = null;
            repair.completedAt = null;
            this.transition(state, operation.projectId, operation.id, operation.phase, operation.attempt, "running", "queued", operation.referenceId);
          }
        } else if (wasRunning && operation.phase === "re_qa" && operation.repairAttemptId) {
          const repair = state.s2Repairs.find((item) => item.id === operation.repairAttemptId);
          const result = state.s2ReQaResults.find((item) => item.id === operation.resultId);
          if (result?.status === "running") {
            result.status = "queued";
            result.startedAt = null;
            result.completedAt = null;
            this.transition(state, operation.projectId, operation.id, operation.phase, operation.attempt, "running", "queued", operation.referenceId);
          }
          if (repair?.status === "re_qa_running") repair.status = "derived_ready";
        }
        operation.status = "queued";
        this.clearClaim(operation);
        operation.startedAt = null;
        operation.completedAt = null;
        ids.push(operation.id);
      }
      return ids;
    });
    for (const id of queued) this.startOperation(id);
  }
}
