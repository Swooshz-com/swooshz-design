import {
  AppError,
  type BoothGeometry,
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
  type StoreState,
  type StructuredBriefData,
  type UUID,
} from "./types";
import { JsonRepository, PrivateObjectStore } from "./store";
import { assertUuid, cloneJson, codePointLength, jcs, newUuid, nowUtc, privateStorageKey, sha256 } from "./utils";
import {
  S2_MAX_LOGOS,
  S2_MAX_REFERENCES,
  S2_MAX_REPAIR_IMAGES,
  S2_MAX_REPAIR_OUTPUT_BYTES,
  S2_MAX_TOTAL_ASSETS,
  enforceS2AggregateLimits,
  inspectCanonicalS1Png,
  normalizeS2Media,
  assertS2Png,
  s2NormalizedMeasure,
} from "./s2-media";
import { S2_QA_MODEL, S2_QA_SCHEMA, type S2ProviderContract, type S2QaProviderInput } from "./s2-provider";
import { ProviderFailure } from "./openai";
import { deriveSourceQaLifecycle, isSourceQaTerminalStatus, latestSourceQaResults } from "./s2-lifecycle";
import { eligibleS2RepairFindingIds, reduceS2Findings, S2_CONFIDENCE_THRESHOLD } from "./s2-findings";
import {
  canonicalRepairInputHash,
  repairAssetProjection,
  repairPromptHash,
  renderS2RepairPrompt,
  type RepairAssetProjection,
} from "./s2-repair";

export { canonicalRepairInputHash, repairPromptHash, renderS2RepairPrompt } from "./s2-repair";

export type S2PublicationPhase =
  | "before-publication-intent"
  | "after-publication-intent"
  | "after-publication-staged"
  | "after-final-promotion";
export type S2DispatchPhase = "before-dispatch" | "after-dispatch-marked";
export type S2WorkflowServiceOptions = {
  repository: JsonRepository;
  objects: PrivateObjectStore;
  provider: S2ProviderContract;
  clock?: () => string;
  uuid?: () => UUID;
  workerId?: string;
  processId?: number;
  isProcessAlive?: (processId: number) => boolean;
  onProviderDispatchPhase?: (phase: S2DispatchPhase, operation: S2Operation) => "interrupt" | void | Promise<"interrupt" | void>;
  onPublicationPhase?: (phase: S2PublicationPhase, publication: S2Publication) => "interrupt" | void | Promise<"interrupt" | void>;
};
export type S2PublicAsset = {
  id: UUID; projectId: UUID; kind: "reference" | "logo"; status: "ready" | "deleted";
  originalBytes: number; normalizedSha256: Sha256; normalizedBytes: number;
  detectedMime: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number;
  hasAlpha: boolean; createdAt: string; deletedAt: string | null;
};
export type S2PublicDraft = {
  id: UUID; projectId: UUID; revision: number; status: "editable" | "frozen";
  referenceAssetIds: UUID[]; logoAssetIds: UUID[]; updatedAt: string; frozenAt: string | null;
  frozenByQaRunId: UUID | null; assets: S2PublicAsset[];
};
type S2PublicRequirementObservation = Pick<S2RequirementObservation,
  "requirementId" | "expected" | "expectedCount" | "expectedValue" | "observed" | "observedCount" | "confidence" | "evidence">;
type S2PublicDesignObservation = Pick<S2DesignObservation, "ruleId" | "observed" | "confidence" | "evidence">;
type S2PublicCandidateCore = {
  id: UUID; qaRunId: UUID; inputVersionId: UUID; candidateId: UUID; candidateIndex: 1 | 2 | 3 | 4; attempt: 1 | 2;
  sourceAssetId: UUID; sourceByteSize: number; status: S2QaCandidateResult["status"]; verdict: S2QaCandidateResult["verdict"];
  requirementObservations: S2PublicRequirementObservation[]; designObservations: S2PublicDesignObservation[];
  materialFindingIds: string[]; warningFindingIds: string[]; uncertainFindingIds: string[];
  startedAt: string | null; completedAt: string | null;
};
type S2PublicCandidate = S2PublicCandidateCore & { repairEligible: boolean; eligibleRepairFindingIds: string[] };
type S2PublicRepair = { candidateId: UUID; status: S2RepairAttempt["status"]; derivedCandidateId: UUID | null };
type S2PublicReQa = { candidateId: UUID; status: S2ReQaResult["status"]; verdict: S2ReQaResult["verdict"] };
type S2PublicSummary = {
  kind: "processing" | "results_available" | "results_include_unavailable" | "all_results_unavailable";
  resultCount: number; unavailableCount: number;
};
export type S2PublicQaProjection = {
  qaRun: {
    id: UUID; projectId: UUID; inputVersionId: UUID; sourceGenerationSetId: UUID; status: S2QaRun["status"];
    candidateResults: S2PublicCandidate[]; candidateAttempts: S2PublicCandidateCore[];
    completedCandidateCount: number; passCount: number; warningCount: number; materialFailCount: number; unavailableCount: number;
    createdAt: string; startedAt: string | null; completedAt: string | null;
    repairs: S2PublicRepair[]; reQa: S2PublicReQa[]; summary: S2PublicSummary;
  };
  input: { id: UUID };
};
export type S2Mutation<T> = T & { replayed: boolean };

const SOURCE_PROVIDER_BYTES = 16 * 1024 * 1024;
const DESIGN_RULES_VERSION = "s2-design-rules-v1" as const;
const DECODER_PROFILE = "s2-media-v1" as const;
class ProcessInterruption extends Error {}

const RULE_CATALOGUE: readonly S2DesignRuleSnapshot[] = [
  "footprint.within-boundary", "access.open-sides", "circulation.primary-access",
  "zones.inside-footprint", "scale.human", "structure.no-floating",
  "structure.overhead-support", "structure.screen-support", "geometry.max-height",
  "geometry.intersections", "branding.prohibited", "branding.style",
  "rigging.confirmation", "budget.complexity",
].map((ruleId) => ({
  ruleId,
  applicability: "applicable" as const,
  materiality: ["branding.style", "rigging.confirmation", "budget.complexity"].includes(ruleId) ? "warning" as const : "material" as const,
  repairable: [
    "footprint.within-boundary", "access.open-sides", "circulation.primary-access",
    "zones.inside-footprint", "scale.human", "structure.no-floating",
    "structure.overhead-support", "structure.screen-support", "geometry.intersections",
    "branding.prohibited",
  ].includes(ruleId),
}));

function fail(status: number, code: string, field = "request"): AppError {
  return new AppError(status, code, [{ field, code }]);
}
export function operationInputHash(operation: string, projectId: UUID, input: unknown): Sha256 {
  return sha256(jcs({ operation, projectId, input }));
}
function terminal(status: string): boolean {
  return isSourceQaTerminalStatus(status);
}
function safeRequestId(value: string | null): string | null {
  return value && value.length <= 200 ? value : null;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = new Set(expected);
  return Object.keys(value).length === expected.length && Object.keys(value).every((key) => keys.has(key));
}
function equalIds(left: readonly UUID[], right: readonly UUID[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function sourceProjection(source: S2CandidateSource): Record<string, unknown> {
  return { candidateId: source.candidateId, candidateIndex: source.candidateIndex, sourceAssetId: source.sourceAssetId,
    sourceSha256: source.sourceSha256, sourceByteSize: source.sourceByteSize, sourceWidth: source.sourceWidth,
    sourceHeight: source.sourceHeight, sourcePixelCount: source.sourcePixelCount, sourceDecodedRgbaBytes: source.sourceDecodedRgbaBytes };
}
function requirementsFor(brief: StructuredBriefData, geometry: BoothGeometry): S2Requirement[] {
  const result: S2Requirement[] = [
    { requirementId: "geometry.width", category: "geometry", expected: "present", expectedCount: null,
      expectedValue: geometry.widthMm, criticality: "material", source: "geometry_snapshot", text: "The booth width is exactly " + geometry.widthMm + " mm." },
    { requirementId: "geometry.depth", category: "geometry", expected: "present", expectedCount: null,
      expectedValue: geometry.depthMm, criticality: "material", source: "geometry_snapshot", text: "The booth depth is exactly " + geometry.depthMm + " mm." },
    { requirementId: "access.open-sides", category: "geometry", expected: "present", expectedCount: null,
      expectedValue: geometry.openSides.join(","), criticality: "material", source: "geometry_snapshot",
      text: "The supplied open sides remain visibly accessible: " + geometry.openSides.join(", ") + "." },
  ];
  if (geometry.maxHeightMm !== null) result.push({
    requirementId: "geometry.max-height", category: "geometry", expected: "present", expectedCount: null,
    expectedValue: geometry.maxHeightMm, criticality: "material", source: "geometry_snapshot",
    text: "Nothing visibly exceeds the supplied maximum height of " + geometry.maxHeightMm + " mm.",
  });
  brief.functionalRequirements.forEach((item, index) => result.push({
    requirementId: "brief.functional." + String(index + 1).padStart(3, "0"), category: "functional",
    expected: item.countIsExact && item.count !== null ? "exact_count" : "present",
    expectedCount: item.countIsExact && item.count !== null ? item.count : null, expectedValue: item.name,
    criticality: "material", source: "confirmed_brief", text: item.details ? item.name + ": " + item.details : item.name,
  }));
  brief.mandatoryRequirements.forEach((item, index) => result.push({
    requirementId: "brief.mandatory." + String(index + 1).padStart(3, "0"), category: "mandatory",
    expected: "present", expectedCount: null, expectedValue: item, criticality: "material",
    source: "confirmed_brief", text: item,
  }));
  brief.prohibitedRequirements.forEach((item, index) => result.push({
    requirementId: "brief.prohibited." + String(index + 1).padStart(3, "0"), category: "prohibited",
    expected: "absent", expectedCount: null, expectedValue: item, criticality: "material",
    source: "confirmed_brief", text: item,
  }));
  brief.freeTextRequirements.forEach((item, index) => result.push({
    requirementId: "brief.free-text." + String(index + 1).padStart(3, "0"), category: "free_text",
    expected: "present", expectedCount: null, expectedValue: item, criticality: "warning",
    source: "confirmed_brief", text: item,
  }));
  return result;
}
function rulesFor(geometry: BoothGeometry): S2DesignRuleSnapshot[] {
  return RULE_CATALOGUE.map((rule) => ({ ...rule,
    applicability: rule.ruleId === "geometry.max-height" && geometry.maxHeightMm === null ? "not_applicable" : "applicable" }));
}

function publicAsset(asset: S2AssetRecord): S2PublicAsset {
  return { id: asset.id, projectId: asset.projectId, kind: asset.kind, status: asset.status,
    originalBytes: asset.originalBytes, normalizedSha256: asset.normalizedSha256,
    normalizedBytes: asset.normalizedBytes, detectedMime: asset.detectedMime, width: asset.width, height: asset.height,
    hasAlpha: asset.hasAlpha, createdAt: asset.createdAt, deletedAt: asset.deletedAt };
}
function publicDraft(state: StoreState, draft: S2ReferenceDraft): S2PublicDraft {
  return {
    id: draft.id,
    projectId: draft.projectId,
    revision: draft.revision,
    status: draft.status,
    referenceAssetIds: draft.referenceAssetIds.slice(),
    logoAssetIds: draft.logoAssetIds.slice(),
    updatedAt: draft.updatedAt,
    frozenAt: draft.frozenAt,
    frozenByQaRunId: draft.frozenByQaRunId,
    assets: state.s2Assets.filter((asset) => asset.projectId === draft.projectId).map(publicAsset),
  };
}
function publicRequirementObservation(observation: S2RequirementObservation): S2PublicRequirementObservation {
  return {
    requirementId: observation.requirementId,
    expected: observation.expected,
    expectedCount: observation.expectedCount,
    expectedValue: observation.expectedValue,
    observed: observation.observed,
    observedCount: observation.observedCount,
    confidence: observation.confidence,
    evidence: observation.evidence,
  };
}
function publicDesignObservation(observation: S2DesignObservation): S2PublicDesignObservation {
  return { ruleId: observation.ruleId, observed: observation.observed, confidence: observation.confidence, evidence: observation.evidence };
}
function publicCandidateCore(candidate: S2QaCandidateResult): S2PublicCandidateCore {
  return {
    id: candidate.id,
    qaRunId: candidate.qaRunId,
    inputVersionId: candidate.inputVersionId,
    candidateId: candidate.candidateId,
    candidateIndex: candidate.candidateIndex,
    attempt: candidate.attempt,
    sourceAssetId: candidate.sourceAssetId,
    sourceByteSize: candidate.sourceByteSize,
    status: candidate.status,
    verdict: candidate.verdict,
    requirementObservations: candidate.requirementObservations.map(publicRequirementObservation),
    designObservations: candidate.designObservations.map(publicDesignObservation),
    materialFindingIds: candidate.materialFindingIds.slice(),
    warningFindingIds: candidate.warningFindingIds.slice(),
    uncertainFindingIds: candidate.uncertainFindingIds.slice(),
    startedAt: candidate.startedAt,
    completedAt: candidate.completedAt,
  };
}
function publicCandidate(candidate: S2QaCandidateResult, eligibleFindingIds: readonly string[] | null, hasRepair: boolean): S2PublicCandidate {
  return {
    id: candidate.id,
    qaRunId: candidate.qaRunId,
    inputVersionId: candidate.inputVersionId,
    candidateId: candidate.candidateId,
    candidateIndex: candidate.candidateIndex,
    attempt: candidate.attempt,
    sourceAssetId: candidate.sourceAssetId,
    sourceByteSize: candidate.sourceByteSize,
    status: candidate.status,
    verdict: candidate.verdict,
    requirementObservations: candidate.requirementObservations.map(publicRequirementObservation),
    designObservations: candidate.designObservations.map(publicDesignObservation),
    materialFindingIds: candidate.materialFindingIds.slice(),
    warningFindingIds: candidate.warningFindingIds.slice(),
    uncertainFindingIds: candidate.uncertainFindingIds.slice(),
    startedAt: candidate.startedAt,
    completedAt: candidate.completedAt,
    repairEligible: eligibleFindingIds !== null && !hasRepair,
    eligibleRepairFindingIds: eligibleFindingIds ? eligibleFindingIds.slice() : [],
  };
}
function publicRepair(repair: S2RepairAttempt): S2PublicRepair {
  return { candidateId: repair.candidateId, status: repair.status, derivedCandidateId: repair.derivedCandidateId };
}
function publicReQa(result: S2ReQaResult): S2PublicReQa {
  return { candidateId: result.candidateId, status: result.status, verdict: result.verdict };
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Evaluated = {
  requirements: S2RequirementObservation[]; designRules: S2DesignObservation[];
  material: string[]; warning: string[]; uncertain: string[];
  verdict: "PASS" | "WARNING" | "MATERIAL_FAIL";
};

function validateProvider(payload: unknown, input: S2InputVersion): {
  requirements: Record<string, unknown>[]; designRules: Record<string, unknown>[];
} {
  if (!isObject(payload) || !exactKeys(payload, ["requirements", "designRules"]) ||
      !Array.isArray(payload.requirements) || !Array.isArray(payload.designRules)) throw fail(502, "QA_SCHEMA_INVALID");
  const requirements = payload.requirements as unknown[];
  const designRules = payload.designRules as unknown[];
  const seenRequirements = new Set<string>();
  const seenRules = new Set<string>();
  for (const raw of requirements) {
    if (!isObject(raw) || !exactKeys(raw, ["requirementId", "expected", "expectedCount", "observed", "observedCount", "confidence", "evidence"])) {
      throw fail(502, "QA_SCHEMA_INVALID");
    }
    const id = raw.requirementId;
    const expected = input.canonicalRequirements.find((item) => item.requirementId === id);
    if (typeof id !== "string" || seenRequirements.has(id) || !expected ||
        raw.expected !== expected.expected || raw.expectedCount !== expected.expectedCount ||
        !["present", "absent", "uncertain", "not_verifiable"].includes(String(raw.observed)) ||
        typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence) ||
        raw.confidence < 0 || raw.confidence > 1 ||
        typeof raw.evidence !== "string" || codePointLength(raw.evidence) > 400) throw fail(502, "QA_SCHEMA_INVALID");
    if (raw.observedCount !== null &&
        (typeof raw.observedCount !== "number" || !Number.isInteger(raw.observedCount) || raw.observedCount < 0)) {
      throw fail(502, "QA_SCHEMA_INVALID");
    }
    const judgedExact = expected.expected === "exact_count" &&
      (raw.observed === "present" || raw.observed === "absent") &&
      raw.confidence >= S2_CONFIDENCE_THRESHOLD;
    if ((expected.expected === "exact_count" && judgedExact && raw.observedCount === null) ||
        (expected.expected !== "exact_count" && raw.observedCount !== null)) throw fail(502, "QA_SCHEMA_INVALID");
    seenRequirements.add(id);
  }
  if (input.canonicalRequirements.some((item) => !seenRequirements.has(item.requirementId))) throw fail(502, "QA_SCHEMA_INVALID");
  for (const raw of designRules) {
    if (!isObject(raw) || !exactKeys(raw, ["ruleId", "observed", "confidence", "evidence"])) throw fail(502, "QA_SCHEMA_INVALID");
    const id = raw.ruleId;
    const expected = input.designRuleSnapshot.find((item) => item.ruleId === id && item.applicability === "applicable");
    if (typeof id !== "string" || seenRules.has(id) || !expected ||
        !["compliant", "non_compliant", "uncertain", "not_verifiable"].includes(String(raw.observed)) ||
        typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence) ||
        raw.confidence < 0 || raw.confidence > 1 ||
        typeof raw.evidence !== "string" || codePointLength(raw.evidence) > 400) throw fail(502, "QA_SCHEMA_INVALID");
    seenRules.add(id);
  }
  if (input.designRuleSnapshot.some((item) => item.applicability === "applicable" && !seenRules.has(item.ruleId))) {
    throw fail(502, "QA_SCHEMA_INVALID");
  }
  return { requirements: requirements as Record<string, unknown>[], designRules: designRules as Record<string, unknown>[] };
}

function evaluate(
  payload: { requirements: Record<string, unknown>[]; designRules: Record<string, unknown>[] },
  input: S2InputVersion,
): Evaluated {
  const requirements: S2RequirementObservation[] = [];
  const designRules: S2DesignObservation[] = [];
  for (const expected of input.canonicalRequirements) {
    const raw = payload.requirements.find((item) => item.requirementId === expected.requirementId)!;
    const observed = raw.observed as S2RequirementObservation["observed"];
    const confidence = raw.confidence as number;
    const observedCount = raw.observedCount as number | null;
    requirements.push({ requirementId: expected.requirementId, expected: expected.expected, expectedCount: expected.expectedCount,
      expectedValue: cloneJson(expected.expectedValue), observed, observedCount, confidence, evidence: raw.evidence as string });
  }
  for (const expected of input.designRuleSnapshot) {
    if (expected.applicability !== "applicable") continue;
    const raw = payload.designRules.find((item) => item.ruleId === expected.ruleId)!;
    const observed = raw.observed as S2DesignObservation["observed"];
    const confidence = raw.confidence as number;
    designRules.push({ ruleId: expected.ruleId, observed, confidence, evidence: raw.evidence as string });
  }
  const reduced = reduceS2Findings(input, requirements, designRules);
  return { requirements, designRules, material: reduced.materialFindingIds, warning: reduced.warningFindingIds,
    uncertain: reduced.uncertainFindingIds, verdict: reduced.verdict };
}

function retryable(error: unknown): boolean {
  return error instanceof ProviderFailure &&
    ["PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMIT", "PROVIDER_SERVER_ERROR", "QA_PROVIDER_INCOMPLETE"].includes(error.safeCode);
}

function isQaCandidateFailure(error: unknown): boolean {
  return error instanceof ProviderFailure || (error instanceof AppError && error.code === "QA_SCHEMA_INVALID");
}

function isReQaCandidateFailure(error: unknown): boolean {
  return error instanceof ProviderFailure || (error instanceof AppError &&
    (error.code === "QA_SCHEMA_INVALID" || error.code === "RE_QA_UNAVAILABLE"));
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
  private readonly onProviderDispatchPhase: S2WorkflowServiceOptions["onProviderDispatchPhase"];
  private readonly onPublicationPhase: S2WorkflowServiceOptions["onPublicationPhase"];
  private readonly inFlight = new Set<UUID>();

  constructor(options: S2WorkflowServiceOptions) {
    this.repository = options.repository;
    this.objects = options.objects;
    this.provider = options.provider;
    this.clock = options.clock ?? nowUtc;
    this.uuid = options.uuid ?? newUuid;
    this.processId = options.processId ?? process.pid;
    this.workerId = options.workerId ?? "s2-worker-" + this.processId;
    this.isProcessAlive = options.isProcessAlive ?? ((pid) => {
      try { process.kill(pid, 0); return true; } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    });
    this.onProviderDispatchPhase = options.onProviderDispatchPhase;
    this.onPublicationPhase = options.onPublicationPhase;
    this.recoverPublications();
    this.recoverOperations();
  }

  private state(): StoreState { return this.repository.state(); }
  private project(state: StoreState, projectId: UUID): void {
    const value = state.projects.find((item) => item.projectId === projectId);
    if (!value) throw fail(404, "PROJECT_NOT_FOUND", "projectId");
    if (!value.boothGeometry || !value.confirmedBriefVersionId) throw fail(409, "S2_NOT_AVAILABLE");
  }
  private draft(state: StoreState, projectId: UUID, create: boolean): S2ReferenceDraft {
    let value = state.s2Drafts.find((item) => item.projectId === projectId);
    if (!value && create) {
      value = { id: this.uuid(), projectId, revision: 1, status: "editable", referenceAssetIds: [], logoAssetIds: [],
        updatedAt: this.clock(), frozenAt: null, frozenByQaRunId: null };
      state.s2Drafts.push(value);
    }
    if (!value) throw fail(404, "S2_DRAFT_NOT_FOUND");
    return value;
  }
  private remember(state: StoreState, key: UUID, operation: string, projectId: UUID, inputHash: Sha256, result: Record<string, unknown>): void {
    state.idempotency.push({ key, operation, projectId, inputHash, result, createdAt: this.clock() });
  }
  private idem(state: StoreState, key: UUID, operation: string, projectId: UUID, inputHash: Sha256): IdempotencyRecord | null {
    const value = state.idempotency.find((item) => item.key === key);
    if (!value) return null;
    if (value.operation !== operation || value.projectId !== projectId || value.inputHash !== inputHash) throw fail(409, "IDEMPOTENCY_KEY_REUSE");
    return value;
  }
  private verify(key: string, bytes: number, digest: Sha256): void {
    const value = this.objects.read(key);
    if (value.byteLength !== bytes || sha256(value) !== digest) throw fail(500, "PERSISTENCE_FAILED");
  }
  private async notify(phase: S2PublicationPhase, publication: S2Publication): Promise<void> {
    if ((await this.onPublicationPhase?.(phase, cloneJson(publication))) === "interrupt") throw new ProcessInterruption();
  }
  private async notifyDispatch(phase: S2DispatchPhase, operation: S2Operation): Promise<void> {
    if ((await this.onProviderDispatchPhase?.(phase, cloneJson(operation))) === "interrupt") throw new ProcessInterruption();
  }
  private markPublication(id: UUID, stateValue: "promoted" | "committed" | "aborted"): void {
    this.repository.transact((state) => {
      const publication = state.s2Publications.find((item) => item.id === id);
      if (publication) { publication.state = stateValue; publication.updatedAt = this.clock(); }
    });
  }
  private cleanup(publication: S2Publication, ownedFinalKeys: readonly string[] = []): void {
    for (const object of publication.stagingObjects) this.objects.remove(object.key);
    for (const key of ownedFinalKeys) this.objects.remove(key);
  }
  private ownerDead(pid: number): boolean {
    try { return this.isProcessAlive(pid) === false; } catch { return false; }
  }
  private objectMatches(object: S2PublicationObject): boolean {
    try { if (!this.objects.exists(object.key)) return false; this.verify(object.key, object.byteSize, object.sha256); return true; } catch { return false; }
  }
  private abortPublication(publication: S2Publication): void {
    this.repository.transact((state) => {
      const stored = state.s2Publications.find((item) => item.id === publication.id);
      if (!stored || stored.state === "committed" || stored.state === "aborted") return;
      if (stored.kind === "repair_output") {
        const operation = state.s2Operations.find((item) => item.id === stored.operationId);
        const repair = state.s2Repairs.find((item) => item.id === stored.repairAttemptId);
        if (repair && repair.derivedCandidateId === null && repair.status !== "failed") {
          const previousStatus = repair.status;
          repair.status = "failed"; repair.completedAt = this.clock();
          if (operation && operation.status === "running") {
            this.transition(state, operation.projectId, operation.id, operation.phase, operation.attempt, previousStatus, "failed", operation.referenceId);
          }
        }
        if (operation && operation.status === "running") {
          operation.status = "failed"; operation.providerDispatchState = "consumed";
          operation.failureCode = "PERSISTENCE_FAILED"; operation.completedAt = this.clock(); this.clearClaim(operation);
        }
      }
      stored.state = "aborted"; stored.updatedAt = this.clock();
    });
  }
  private abortRepairPublicationIfOwned(publicationId: UUID, operationId: UUID, token: UUID): boolean {
    return this.repository.transact((state) => {
      const publication = state.s2Publications.find((item) => item.id === publicationId);
      const operation = state.s2Operations.find((item) => item.id === operationId);
      if (!publication || publication.kind !== "repair_output" ||
          publication.state === "committed" || publication.state === "aborted" ||
          !operation || !this.claimMatches(operation, token)) return false;
      publication.state = "aborted";
      publication.updatedAt = this.clock();
      return true;
    });
  }

  private transition(state: StoreState, projectId: UUID, operationId: UUID, phase: S2Operation["phase"], attempt: 1 | 2, from: string, to: string, referenceId: UUID): void {
    state.s2Transitions.push({ id: this.uuid(), projectId, operationId, phase, attempt, from, to, referenceId, at: this.clock() });
  }
  private clearClaim(operation: S2Operation): void {
    operation.claimedBy = null; operation.claimedProcessId = null; operation.claimToken = null; operation.claimedAt = null;
  }
  private claimMatches(operation: S2Operation, token: UUID): boolean {
    return operation.status === "running" && operation.claimToken === token &&
      operation.claimedBy === this.workerId && operation.claimedProcessId === this.processId;
  }
  private operationInputMatches(state: StoreState, operation: S2Operation): boolean {
    const run = state.s2QaRuns.find((item) => item.id === operation.qaRunId);
    if (!run) return false;
    if (operation.phase === "qa" || operation.phase === "re_qa") {
      const input = state.s2Inputs.find((item) => item.id === run.inputVersionId);
      return input?.inputHash === operation.inputHash;
    }
    const repair = operation.repairAttemptId
      ? state.s2Repairs.find((item) => item.id === operation.repairAttemptId)
      : undefined;
    return repair !== undefined &&
      operation.inputHash === operationInputHash("s2_repair", operation.projectId, {
        qaRunId: operation.qaRunId,
        candidateId: operation.candidateId,
        expectedInputVersionId: repair.inputVersionId,
        eligibleFindingIds: repair.eligibleFindingIds,
      });
  }
  private operationIntegrityVerified(state: StoreState, operation: S2Operation): boolean {
    try {
      if (!this.operationInputMatches(state, operation)) return false;
      const run = state.s2QaRuns.find((item) => item.id === operation.qaRunId);
      if (!run) return false;
      const input = this.inputFor(state, run);
      if (operation.phase === "qa") {
        this.sourceBytes(input, operation.candidateId);
        return true;
      }
      if (operation.phase === "repair") {
        const repair = operation.repairAttemptId ? state.s2Repairs.find((item) => item.id === operation.repairAttemptId) : undefined;
        const source = input.sourceCandidates.find((item) => item.candidateId === operation.candidateId);
        if (!repair || !source) return false;
        const latest = this.latest(run, operation.candidateId);
        const eligible = eligibleS2RepairFindingIds(latest, input);
        if (!eligible || !equalIds(eligible, repair.eligibleFindingIds)) return false;
        const images = this.repairImages(state, input, operation.candidateId);
        const repairHash = canonicalRepairInputHash(input, source, eligible, images.referenceAssets, images.logoAssets);
        if (repairHash !== repair.repairInputHash) return false;
        const prompt = renderS2RepairPrompt(input, source, eligible, images.referenceAssets, images.logoAssets, repair.repairInputHash);
        return repairPromptHash(prompt) === repair.repairPromptHash;
      }
      const derived = state.s2DerivedCandidates.find((item) => item.id === state.s2ReQaResults.find((item) => item.id === operation.resultId)?.derivedCandidateId);
      if (!derived) return false;
      const bytes = this.objects.read(derived.storageKeyNormalized);
      return bytes.byteLength === derived.normalizedBytes && sha256(bytes) === derived.outputSha256;
    } catch {
      return false;
    }
  }
  private beginProviderDispatch(operationId: UUID, token: UUID): S2Operation | null {
    return this.repository.transact((state) => {
      const operation = state.s2Operations.find((item) => item.id === operationId);
      if (!operation || !this.claimMatches(operation, token)) return null;
      if (operation.providerDispatchState !== "not_started") return null;
      if (!this.operationInputMatches(state, operation)) throw fail(409, "STATE_CONFLICT");
      operation.providerDispatchState = "may_have_started";
      return cloneJson(operation);
    });
  }
  private requeueUnstartedOperation(state: StoreState, operation: S2Operation): void {
    const wasRunning = operation.status === "running";
    const run = state.s2QaRuns.find((item) => item.id === operation.qaRunId);
    const result = operation.phase === "qa"
      ? run?.candidateResults.find((item) => item.id === operation.resultId)
      : operation.phase === "re_qa" ? state.s2ReQaResults.find((item) => item.id === operation.resultId) : undefined;
    const repair = operation.phase !== "qa" && operation.repairAttemptId
      ? state.s2Repairs.find((item) => item.id === operation.repairAttemptId)
      : undefined;
    const previousStatus = operation.phase === "qa" ? result?.status : operation.phase === "repair" ? repair?.status : result?.status;
    operation.status = "queued";
    operation.startedAt = null;
    operation.completedAt = null;
    this.clearClaim(operation);
    if (run && operation.phase === "qa") {
      const sourceResult = run.candidateResults.find((item) => item.id === operation.resultId);
      if (sourceResult) {
        sourceResult.status = "queued";
        sourceResult.startedAt = null;
        sourceResult.completedAt = null;
        sourceResult.providerRequestId = null;
      }
      this.recompute(run);
    }
    if (operation.phase === "repair" && operation.repairAttemptId) {
      const repair = state.s2Repairs.find((item) => item.id === operation.repairAttemptId);
      if (repair) {
        repair.status = "queued";
        repair.startedAt = null;
        repair.completedAt = null;
        repair.providerRequestId = null;
      }
    }
    if (operation.phase === "re_qa" && operation.repairAttemptId) {
      const repair = state.s2Repairs.find((item) => item.id === operation.repairAttemptId);
      const result = state.s2ReQaResults.find((item) => item.id === operation.resultId);
      if (repair) repair.status = "derived_ready";
      if (result) {
        result.status = "queued";
        result.startedAt = null;
        result.completedAt = null;
        result.providerRequestId = null;
      }
    }
    if (wasRunning && previousStatus !== undefined) {
      this.transition(state, operation.projectId, operation.id, operation.phase, operation.attempt, previousStatus, "queued", operation.referenceId);
    }
  }
  private resolveAmbiguousOperation(state: StoreState, operation: S2Operation): void {
    const run = state.s2QaRuns.find((item) => item.id === operation.qaRunId);
    let previousStatus: string | undefined;
    let nextStatus: string;
    if (operation.phase === "qa") {
      const result = run?.candidateResults.find((item) => item.id === operation.resultId);
      if (result) {
        previousStatus = result.status;
        result.status = operation.attempt === 1 ? "qa_unavailable_retryable" : "qa_unavailable_terminal";
        result.verdict = "QA_UNAVAILABLE";
        result.requirementObservations = [];
        result.designObservations = [];
        result.materialFindingIds = [];
        result.warningFindingIds = [];
        result.uncertainFindingIds = [];
        result.providerRequestId = null;
        result.completedAt = this.clock();
        nextStatus = result.status;
      }
      if (run) this.recompute(run);
      operation.failureCode = "PROVIDER_UNAVAILABLE";
    } else if (operation.phase === "repair") {
      const repair = operation.repairAttemptId
        ? state.s2Repairs.find((item) => item.id === operation.repairAttemptId)
        : undefined;
      if (repair) {
        previousStatus = repair.status;
        repair.status = "failed";
        repair.providerRequestId = null;
        repair.completedAt = this.clock();
      }
      nextStatus = "failed";
      operation.failureCode = "REPAIR_PROVIDER_FAILED";
    } else {
      const result = state.s2ReQaResults.find((item) => item.id === operation.resultId);
      const repair = operation.repairAttemptId
        ? state.s2Repairs.find((item) => item.id === operation.repairAttemptId)
        : undefined;
      if (result) {
        previousStatus = result.status;
        result.status = "re_qa_unavailable";
        result.verdict = "QA_UNAVAILABLE";
        result.requirementObservations = [];
        result.designObservations = [];
        result.materialFindingIds = [];
        result.warningFindingIds = [];
        result.uncertainFindingIds = [];
        result.providerRequestId = null;
        result.completedAt = this.clock();
      }
      if (repair) {
        repair.status = "re_qa_unavailable";
        repair.completedAt = this.clock();
      }
      nextStatus = "re_qa_unavailable";
      operation.failureCode = "RE_QA_UNAVAILABLE";
    }
    if (previousStatus !== undefined) {
      this.transition(state, operation.projectId, operation.id, operation.phase, operation.attempt, previousStatus, nextStatus!, operation.referenceId);
    }
    operation.providerDispatchState = "consumed";
    operation.status = "failed";
    operation.completedAt = this.clock();
    this.clearClaim(operation);
  }
  private commitRepairPublication(state: StoreState, publication: S2RepairPublication): void {
    const operation = state.s2Operations.find((item) => item.id === publication.operationId);
    const reQaCreated = !state.s2Operations.some((item) => item.id === publication.intendedReQaOperation.id);
    if (!state.s2DerivedCandidates.some((item) => item.id === publication.intendedDerived.id)) {
      state.s2DerivedCandidates.push(cloneJson(publication.intendedDerived));
    }
    if (!state.s2ReQaResults.some((item) => item.id === publication.intendedReQa.id)) {
      state.s2ReQaResults.push(cloneJson(publication.intendedReQa));
    }
    if (reQaCreated) {
      state.s2Operations.push(cloneJson(publication.intendedReQaOperation));
    }
    const repair = state.s2Repairs.find((item) => item.id === publication.repairAttemptId);
    if (repair) {
      repair.status = "derived_ready"; repair.outputSha256 = publication.intendedDerived.outputSha256;
      repair.derivedCandidateId = publication.intendedDerived.id; repair.reQaCandidateResultId = publication.intendedReQa.id;
      repair.providerRequestId = publication.providerRequestId; repair.completedAt = this.clock();
    }
    if (operation && operation.status === "running") {
      operation.status = "succeeded"; operation.providerDispatchState = "consumed"; operation.completedAt = this.clock(); this.clearClaim(operation);
      this.transition(state, operation.projectId, operation.id, operation.phase, operation.attempt, "running", "derived_ready", operation.referenceId);
    }
    if (operation && reQaCreated) {
      this.transition(state, operation.projectId, publication.intendedReQaOperation.id, "re_qa", 1, "derived_ready", "queued", operation.referenceId);
    }
  }
  private recoverPublications(): void {
    const pending = this.state().s2Publications.filter((item) => item.state === "staged" || item.state === "promoted");
    for (const publication of pending) {
      if (publication.kind === "asset_upload" && !this.ownerDead(publication.ownerProcessId)) continue;
      if (publication.kind === "repair_output") {
        const operation = this.state().s2Operations.find((item) => item.id === publication.operationId);
        if (operation?.claimedProcessId !== null && operation && !this.ownerDead(operation.claimedProcessId)) continue;
      }
      try {
        const stagingReady = publication.stagingObjects.every((item) => this.objectMatches(item));
        if (!publication.finalObjects.every((item) => this.objectMatches(item)) && stagingReady) {
          publication.stagingObjects.forEach((item, index) => {
            const target = publication.finalObjects[index];
            if (!this.objects.exists(target.key)) this.objects.promote(item.key, target.key);
          });
        }
        if (!publication.finalObjects.every((item) => this.objectMatches(item))) {
          this.cleanup(publication); this.abortPublication(publication); continue;
        }
        this.repository.transact((state) => {
          const stored = state.s2Publications.find((item) => item.id === publication.id);
          if (!stored || stored.state === "committed" || stored.state === "aborted") return;
          if (stored.kind === "asset_upload") {
            if (!state.s2Assets.some((item) => item.id === stored.intendedAsset.id)) state.s2Assets.push(cloneJson(stored.intendedAsset));
            if (!state.idempotency.some((item) => item.key === stored.idempotencyKey)) {
              this.remember(state, stored.idempotencyKey, "s2_asset_upload", stored.projectId, stored.inputHash, { assetId: stored.assetId });
            }
          } else this.commitRepairPublication(state, stored);
          stored.state = "committed"; stored.updatedAt = this.clock();
        });
        this.cleanup(publication);
      } catch {
        // Unknown or failed recovery remains durable and conservative.
      }
    }
  }
  private recoverOperations(): void {
    const ids = this.repository.transact((state) => {
      const result: UUID[] = [];
      for (const operation of state.s2Operations) {
        if (operation.status === "running" && operation.claimedProcessId !== null) {
          let live = true;
          try { live = this.isProcessAlive(operation.claimedProcessId); } catch { live = true; }
          if (live) continue;
          if (!this.operationIntegrityVerified(state, operation)) continue;
          if (operation.providerDispatchState === "not_started") {
            this.requeueUnstartedOperation(state, operation);
          } else {
            this.resolveAmbiguousOperation(state, operation);
          }
        }
        if (operation.status === "queued" && operation.providerDispatchState === "not_started") {
          if (!this.operationIntegrityVerified(state, operation)) continue;
          result.push(operation.id);
        } else if (operation.status === "queued" && operation.providerDispatchState === "may_have_started") {
          this.resolveAmbiguousOperation(state, operation);
        }
      }
      return result;
    });
    ids.forEach((id) => this.startOperation(id));
  }

  authorizeProject(projectId: UUID): void { this.project(this.state(), projectId); }
  getReferenceDraft(projectId: UUID): S2PublicDraft {
    this.repository.transact((state) => { this.project(state, projectId); this.draft(state, projectId, true); });
    const state = this.state();
    return publicDraft(state, this.draft(state, projectId, false));
  }

  async uploadAsset(projectId: UUID, kind: unknown, fileName: string | undefined, mimeType: string, bytes: Uint8Array, key: UUID):
    Promise<S2Mutation<{ asset: S2PublicAsset; draft: S2PublicDraft }>> {
    if (kind !== "reference" && kind !== "logo") throw fail(400, "INVALID_ASSET_KIND", "kind");
    const before = this.state(); this.project(before, projectId);
    if (before.s2Drafts.find((item) => item.projectId === projectId)?.status === "frozen") throw fail(409, "DRAFT_FROZEN");
    const media = await normalizeS2Media({ kind, fileName, mimeType, bytes, maxInputBytes: 8_388_608 });
    const inputHash = operationInputHash("s2_asset_upload", projectId, { kind, originalSha256: media.originalSha256, originalBytes: media.originalBytes.byteLength });
    const replayId = this.repository.transact((state) => {
      this.project(state, projectId);
      if (this.draft(state, projectId, true).status === "frozen") throw fail(409, "DRAFT_FROZEN");
      const replay = this.idem(state, key, "s2_asset_upload", projectId, inputHash);
      return replay ? String(replay.result.assetId) : null;
    });
    if (replayId) {
      const state = this.state(); const asset = state.s2Assets.find((item) => item.id === replayId);
      if (!asset) throw fail(500, "PERSISTENCE_FAILED");
      return { asset: publicAsset(asset), draft: publicDraft(state, this.draft(state, projectId, false)), replayed: true };
    }
    const assetId = this.uuid();
    const stagedOriginal = privateStorageKey("projects", projectId, "s2", "staging", "reference-assets", assetId, "original");
    const stagedNormalized = privateStorageKey("projects", projectId, "s2", "staging", "reference-assets", assetId, "normalized.png");
    const finalOriginal = privateStorageKey("projects", projectId, "s2", "references", assetId, "original");
    const finalNormalized = privateStorageKey("projects", projectId, "s2", "references", assetId, "normalized.png");
    const intended: S2AssetRecord = { id: assetId, projectId, kind, status: "ready",
      originalSha256: media.originalSha256, originalBytes: media.originalBytes.byteLength,
      normalizedSha256: media.normalizedSha256, normalizedBytes: media.normalizedBytes.byteLength,
      detectedMime: media.detectedMime, width: media.width, height: media.height, pixelCount: media.pixelCount,
      hasAlpha: media.hasAlpha, storageKeyOriginal: finalOriginal, storageKeyNormalized: finalNormalized,
      createdAt: this.clock(), deletedAt: null };
    const publication: S2UploadPublication = { kind: "asset_upload", id: this.uuid(), projectId, assetId,
      idempotencyKey: key, inputHash, ownerProcessId: this.processId,
      stagingObjects: [{ key: stagedOriginal, sha256: media.originalSha256, byteSize: media.originalBytes.byteLength },
        { key: stagedNormalized, sha256: media.normalizedSha256, byteSize: media.normalizedBytes.byteLength }],
      finalObjects: [{ key: finalOriginal, sha256: media.originalSha256, byteSize: media.originalBytes.byteLength },
        { key: finalNormalized, sha256: media.normalizedSha256, byteSize: media.normalizedBytes.byteLength }],
      intendedAsset: intended, state: "staged", createdAt: this.clock(), updatedAt: this.clock() };
    const promotedFinalKeys: string[] = [];
    try {
      this.objects.put(stagedOriginal, media.originalBytes); this.verify(stagedOriginal, media.originalBytes.byteLength, media.originalSha256);
      this.objects.put(stagedNormalized, media.normalizedBytes); this.verify(stagedNormalized, media.normalizedBytes.byteLength, media.normalizedSha256);
      this.repository.transact((state) => {
        this.project(state, projectId); if (this.draft(state, projectId, true).status === "frozen") throw fail(409, "DRAFT_FROZEN");
        state.s2Publications.push(cloneJson(publication));
      });
      await this.notify("after-publication-staged", publication);
      this.objects.promote(stagedOriginal, finalOriginal); promotedFinalKeys.push(finalOriginal);
      this.objects.promote(stagedNormalized, finalNormalized); promotedFinalKeys.push(finalNormalized);
      this.markPublication(publication.id, "promoted"); await this.notify("after-final-promotion", publication);
      const committed = this.repository.transact((state) => {
        const stored = state.s2Publications.find((item) => item.id === publication.id);
        const replay = this.idem(state, key, "s2_asset_upload", projectId, inputHash);
        if (replay) { if (stored) stored.state = "aborted"; return { id: String(replay.result.assetId), replayed: true }; }
        if (!stored || stored.state !== "promoted") throw fail(500, "PERSISTENCE_FAILED");
        if (state.s2Assets.some((item) => item.projectId === projectId && item.status === "ready" && item.originalSha256 === intended.originalSha256)) throw fail(409, "MEDIA_DUPLICATE");
        state.s2Assets.push(cloneJson(intended)); this.remember(state, key, "s2_asset_upload", projectId, inputHash, { assetId });
        stored.state = "committed"; stored.updatedAt = this.clock(); return { id: assetId, replayed: false };
      });
      this.cleanup(publication, committed.replayed ? promotedFinalKeys : []); const state = this.state();
      const asset = state.s2Assets.find((item) => item.id === committed.id);
      if (!asset) throw fail(500, "PERSISTENCE_FAILED");
      return { asset: publicAsset(asset), draft: publicDraft(state, this.draft(state, projectId, false)), replayed: committed.replayed };
    } catch (error) {
      if (error instanceof ProcessInterruption) throw error;
      this.cleanup(publication, promotedFinalKeys); try { this.markPublication(publication.id, "aborted"); } catch { /* recovery remains conservative */ }
      throw error;
    }
  }

  updateDraft(projectId: UUID, expectedRevision: unknown, referenceAssetIds: unknown, logoAssetIds: unknown, key: UUID):
    S2Mutation<{ draft: S2PublicDraft }> {
    if (!Array.isArray(referenceAssetIds) || !Array.isArray(logoAssetIds) ||
        typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) throw fail(400, "INVALID_REQUEST");
    const refs = referenceAssetIds.map((id) => { assertUuid(id, "referenceAssetIds"); return id; });
    const logos = logoAssetIds.map((id) => { assertUuid(id, "logoAssetIds"); return id; });
    const result = this.repository.transact((state) => {
      this.project(state, projectId); const draft = this.draft(state, projectId, true);
      const inputHash = operationInputHash("s2_draft_update", projectId, { draftId: draft.id, expectedRevision, referenceAssetIds: refs, logoAssetIds: logos });
      if (draft.status === "frozen") throw fail(409, "DRAFT_FROZEN");
      if (this.idem(state, key, "s2_draft_update", projectId, inputHash)) return { draft: cloneJson(draft), replayed: true };
      if (draft.revision !== expectedRevision) throw fail(409, "DRAFT_REVISION_CONFLICT");
      if (new Set(refs).size !== refs.length || new Set(logos).size !== logos.length ||
          new Set([...refs, ...logos]).size !== refs.length + logos.length) throw fail(409, "MEDIA_DUPLICATE");
      if (refs.length > S2_MAX_REFERENCES || logos.length > S2_MAX_LOGOS || refs.length + logos.length > S2_MAX_TOTAL_ASSETS) throw fail(422, "DRAFT_LIMIT_EXCEEDED");
      for (const [ids, kind] of [[refs, "reference"], [logos, "logo"]] as const) for (const id of ids) {
        const asset = state.s2Assets.find((item) => item.id === id);
        if (!asset || asset.status !== "ready") throw fail(404, "ASSET_NOT_FOUND");
        if (asset.projectId !== projectId) throw fail(404, "ASSET_PROJECT_MISMATCH");
        if (asset.kind !== kind) throw fail(409, "ASSET_KIND_MISMATCH");
      }
      if (!equalIds(draft.referenceAssetIds, refs) || !equalIds(draft.logoAssetIds, logos)) {
        draft.referenceAssetIds = refs.slice(); draft.logoAssetIds = logos.slice(); draft.revision += 1; draft.updatedAt = this.clock();
      }
      this.remember(state, key, "s2_draft_update", projectId, inputHash, { draftId: draft.id });
      return { draft: cloneJson(draft), replayed: false };
    });
    const state = this.state(); return { draft: publicDraft(state, result.draft), replayed: result.replayed };
  }

  private async sourcesFor(projectId: UUID, generationSetId: UUID): Promise<S2CandidateSource[]> {
    const state = this.state(); this.project(state, projectId);
    const project = state.projects.find((item) => item.projectId === projectId)!;
    if (project.activeGenerationSetId !== generationSetId) throw fail(409, "QA_BINDING_CONFLICT");
    const set = state.generationSets.find((item) => item.generationSetId === generationSetId);
    if (!set || set.projectId !== projectId || set.status !== "succeeded") throw fail(409, "S2_NOT_AVAILABLE");
    const candidates = state.candidates.filter((item) => item.generationSetId === generationSetId).sort((a, b) => a.candidateIndex - b.candidateIndex);
    if (candidates.length !== 4 || candidates.some((item, index) => item.candidateIndex !== index + 1)) throw fail(409, "QA_BINDING_CONFLICT");
    const result: S2CandidateSource[] = [];
    for (const candidate of candidates) {
      if (candidate.projectId !== projectId || candidate.confirmedBriefVersionId !== project.confirmedBriefVersionId) throw fail(409, "QA_BINDING_CONFLICT");
      const asset = state.conceptAssets.find((item) => item.assetId === candidate.assetId);
      if (!asset || asset.projectId !== projectId || asset.generationSetId !== generationSetId || asset.status !== "stored" || asset.mimeType !== "image/png") throw fail(409, "QA_BINDING_CONFLICT");
      try {
        const bytes = this.objects.read(asset.storageKey);
        if (bytes.byteLength !== asset.byteSize || sha256(bytes) !== asset.sha256 || bytes.byteLength > SOURCE_PROVIDER_BYTES) throw new Error("identity");
        const measure = await inspectCanonicalS1Png(bytes);
        result.push({ candidateId: candidate.candidateId, candidateIndex: candidate.candidateIndex, sourceAssetId: asset.assetId,
          sourceStorageKey: asset.storageKey, sourceSha256: asset.sha256, sourceByteSize: asset.byteSize,
          sourceWidth: measure.width, sourceHeight: measure.height, sourcePixelCount: measure.pixelCount,
          sourceDecodedRgbaBytes: measure.decodedRgbaBytes });
      } catch { throw fail(409, "QA_BINDING_CONFLICT"); }
    }
    return result;
  }
  private selectedMeasures(state: StoreState, draft: S2ReferenceDraft, sources: readonly S2CandidateSource[]) {
    const measures = sources.map((item) => ({ encodedBytes: item.sourceByteSize, width: item.sourceWidth, height: item.sourceHeight,
      pixelCount: item.sourcePixelCount, decodedRgbaBytes: item.sourceDecodedRgbaBytes }));
    const selected = [...draft.referenceAssetIds.map((id) => ({ id, kind: "reference" as const })),
      ...draft.logoAssetIds.map((id) => ({ id, kind: "logo" as const }))];
    for (const item of selected) {
      const asset = state.s2Assets.find((candidate) => candidate.id === item.id);
      if (!asset || asset.status !== "ready") throw fail(404, "ASSET_NOT_FOUND");
      if (asset.projectId !== draft.projectId) throw fail(404, "ASSET_PROJECT_MISMATCH");
      if (asset.kind !== item.kind) throw fail(409, "ASSET_KIND_MISMATCH");
      if (asset.pixelCount !== asset.width * asset.height) throw fail(409, "QA_BINDING_CONFLICT");
      const bytes = this.objects.read(asset.storageKeyNormalized);
      if (bytes.byteLength !== asset.normalizedBytes || sha256(bytes) !== asset.normalizedSha256) throw fail(409, "QA_BINDING_CONFLICT");
      measures.push({ ...s2NormalizedMeasure({ normalizedBytes: bytes, width: asset.width, height: asset.height }), encodedBytes: bytes.byteLength });
    }
    return measures;
  }
  async bindQa(projectId: UUID, sourceGenerationSetId: UUID, expectedDraftRevision: unknown, key: UUID, referenceId: UUID):
    Promise<S2Mutation<{ qaRun: S2QaRun; inputVersionId: UUID }>> {
    if (typeof expectedDraftRevision !== "number" || !Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 1) throw fail(400, "INVALID_REQUEST");
    const sources = await this.sourcesFor(projectId, sourceGenerationSetId);
    const result = this.repository.transact((state) => {
      this.project(state, projectId);
      const project = state.projects.find((item) => item.projectId === projectId)!;
      const briefId = project.confirmedBriefVersionId;
      if (!briefId) throw fail(409, "S2_NOT_AVAILABLE");
      const brief = state.briefVersions.find((item) => item.briefVersionId === briefId);
      if (!brief || brief.projectId !== projectId || brief.status !== "confirmed") throw fail(409, "S2_NOT_AVAILABLE");
      const draft = this.draft(state, projectId, false);
      enforceS2AggregateLimits(this.selectedMeasures(state, draft, sources), "assets", 4 + S2_MAX_TOTAL_ASSETS);
      const rules = rulesFor(brief.geometrySnapshot);
      const requirements = requirementsFor(brief.data, brief.geometrySnapshot);
      const referenceAssets = draft.referenceAssetIds.map((id, slot) => {
        const asset = state.s2Assets.find((item) => item.id === id)!;
        return { assetId: id, normalizedSha256: asset.normalizedSha256, width: asset.width, height: asset.height, normalizedBytes: asset.normalizedBytes, slot: slot + 1 };
      });
      const logoAssets = draft.logoAssetIds.map((id, slot) => {
        const asset = state.s2Assets.find((item) => item.id === id)!;
        return { assetId: id, normalizedSha256: asset.normalizedSha256, width: asset.width, height: asset.height, normalizedBytes: asset.normalizedBytes, slot: slot + 1 };
      });
      const geometryHash = sha256(jcs(brief.geometrySnapshot));
      const requirementHash = sha256(jcs({ schemaVersion: "s2-requirements-v1", requirements }));
      const inputHash = sha256(jcs({ schemaVersion: "s2-input-v1", sourceGenerationSetId, sourceCandidates: sources.map(sourceProjection),
        confirmedBriefVersionId: brief.briefVersionId, confirmedBriefContentHash: brief.contentHash, geometryHash, requirementHash,
        designRulesVersion: DESIGN_RULES_VERSION, designRuleSnapshot: rules, decoderProfile: DECODER_PROFILE,
        qaModel: S2_QA_MODEL, qaSchema: S2_QA_SCHEMA, referenceAssets, logoAssets }));
      const bindingHash = sha256(jcs({ schemaVersion: "s2-binding-v1", projectId, sourceGenerationSetId,
        draftRevision: draft.revision, inputHash, sourceCandidates: sources.map(sourceProjection), referenceAssets, logoAssets }));
      const idemHash = operationInputHash("s2_bind", projectId, { sourceGenerationSetId, expectedDraftRevision, bindingHash });
      const replay = this.idem(state, key, "s2_bind", projectId, idemHash);
      if (replay) {
        const run = state.s2QaRuns.find((item) => item.id === String(replay.result.qaRunId));
        if (!run) throw fail(500, "PERSISTENCE_FAILED");
        return { qaRun: cloneJson(run), inputVersionId: String(replay.result.inputVersionId), replayed: true };
      }
      if (state.s2QaRuns.some((item) => item.sourceGenerationSetId === sourceGenerationSetId)) throw fail(409, "S2_QA_RUN_EXISTS");
      if (draft.status === "frozen") throw fail(409, "DRAFT_FROZEN");
      if (draft.revision !== expectedDraftRevision) throw fail(409, "DRAFT_REVISION_CONFLICT");
      const inputVersionId = this.uuid(); const qaRunId = this.uuid();
      const input: S2InputVersion = { id: inputVersionId, projectId, sourceGenerationSetId, sourceCandidates: cloneJson(sources),
        confirmedBriefVersionId: brief.briefVersionId, confirmedBriefContentHash: brief.contentHash,
        geometrySnapshot: cloneJson(brief.geometrySnapshot), geometryHash, canonicalRequirements: cloneJson(requirements),
        requirementHash, designRulesVersion: DESIGN_RULES_VERSION, designRuleSnapshot: cloneJson(rules),
        decoderProfile: DECODER_PROFILE, qaModel: S2_QA_MODEL, qaSchema: S2_QA_SCHEMA,
        referenceAssetIds: draft.referenceAssetIds.slice(), logoAssetIds: draft.logoAssetIds.slice(),
        draftRevision: draft.revision, inputHash, bindingHash, status: "bound", createdAt: this.clock(), boundAt: this.clock(), qaRunId };
      const results: S2QaCandidateResult[] = sources.map((source) => ({
        id: this.uuid(), qaRunId, inputVersionId, candidateId: source.candidateId, candidateIndex: source.candidateIndex, attempt: 1,
        sourceAssetId: source.sourceAssetId, sourceByteSize: source.sourceByteSize, sourceSha256: source.sourceSha256,
        status: "queued", verdict: "QA_UNAVAILABLE", requirementObservations: [], designObservations: [],
        materialFindingIds: [], warningFindingIds: [], uncertainFindingIds: [], providerRequestId: null, repairAttemptId: null, startedAt: null, completedAt: null,
      }));
      const run: S2QaRun = { id: qaRunId, projectId, inputVersionId, sourceGenerationSetId, status: "queued",
        candidateResults: results, completedCandidateCount: 0, passCount: 0, warningCount: 0, materialFailCount: 0, unavailableCount: 0,
        createdAt: this.clock(), startedAt: null, completedAt: null };
      state.s2Inputs.push(input); state.s2QaRuns.push(run);
      draft.status = "frozen"; draft.frozenAt = this.clock(); draft.frozenByQaRunId = qaRunId; draft.updatedAt = this.clock();
      const operationIds: UUID[] = [];
      for (const item of results) {
        const operationId = this.uuid(); operationIds.push(operationId);
        state.s2Operations.push({ id: operationId, projectId, phase: "qa", attempt: 1, qaRunId, candidateId: item.candidateId,
          repairAttemptId: null, inputHash, referenceId, status: "queued", claimedBy: null, claimedProcessId: null, claimToken: null,
          claimedAt: null, startedAt: null, completedAt: null, providerDispatchState: "not_started", failureCode: null, resultId: item.id });
        this.transition(state, projectId, operationId, "qa", 1, "none", "queued", referenceId);
      }
      this.remember(state, key, "s2_bind", projectId, idemHash, { inputVersionId, qaRunId, operationIds });
      return { qaRun: cloneJson(run), inputVersionId, replayed: false };
    });
    if (!result.replayed) this.state().s2Operations.filter((item) => item.qaRunId === result.qaRun.id && item.phase === "qa").forEach((item) => this.startOperation(item.id));
    return { ...result, qaRun: cloneJson(result.qaRun) };
  }

  getAsset(projectId: UUID, assetId: UUID): { bytes: Buffer; contentType: "image/png" } {
    const state = this.state(); this.project(state, projectId);
    const asset = state.s2Assets.find((item) => item.id === assetId);
    if (!asset || asset.projectId !== projectId || asset.status !== "ready") throw fail(404, "ASSET_NOT_FOUND");
    const bytes = this.objects.read(asset.storageKeyNormalized);
    if (bytes.byteLength !== asset.normalizedBytes || sha256(bytes) !== asset.normalizedSha256) throw fail(409, "QA_BINDING_CONFLICT");
    return { bytes, contentType: "image/png" };
  }
  getCandidatePreview(projectId: UUID, qaRunId: UUID, candidateId: UUID): { bytes: Buffer; contentType: "image/png" } {
    const state = this.state(); this.project(state, projectId);
    const run = state.s2QaRuns.find((item) => item.id === qaRunId);
    if (!run || run.projectId !== projectId) throw fail(404, "QA_NOT_FOUND");
    const input = state.s2Inputs.find((item) => item.id === run.inputVersionId);
    const candidate = run.candidateResults.find((item) => item.candidateId === candidateId);
    const source = input?.sourceCandidates.find((item) => item.candidateId === candidateId);
    if (!input || !candidate || !source || candidate.sourceAssetId !== source.sourceAssetId ||
        candidate.sourceSha256 !== source.sourceSha256 || candidate.sourceByteSize !== source.sourceByteSize) {
      throw fail(404, "CANDIDATE_NOT_FOUND");
    }
    try {
      const bytes = this.objects.read(source.sourceStorageKey);
      if (bytes.byteLength !== source.sourceByteSize || sha256(bytes) !== source.sourceSha256) throw new Error("identity");
      return { bytes, contentType: "image/png" };
    } catch {
      throw fail(404, "CANDIDATE_NOT_FOUND");
    }
  }
  private inputFor(state: StoreState, run: S2QaRun): S2InputVersion {
    const input = state.s2Inputs.find((item) => item.id === run.inputVersionId);
    if (!input) throw fail(404, "S2_INPUT_NOT_FOUND");
    return input;
  }
  private latest(run: S2QaRun, candidateId: UUID): S2QaCandidateResult {
    const value = latestSourceQaResults(run.candidateResults.filter((item) => item.candidateId === candidateId))[0];
    if (!value) throw fail(404, "QA_NOT_FOUND");
    return value;
  }
  private publicRun(state: StoreState, run: S2QaRun): S2PublicQaProjection {
    const input = this.inputFor(state, run);
    const latest = latestSourceQaResults(run.candidateResults);
    const repairs = state.s2Repairs.filter((item) => item.qaRunId === run.id);
    const candidates = latest.map((candidate) => {
      const eligibleFindingIds = this.eligibleFindings(candidate, input);
      const hasRepair = repairs.some((repair) => repair.candidateId === candidate.candidateId);
      return publicCandidate(candidate, eligibleFindingIds, hasRepair);
    });
    const candidateAttempts = run.candidateResults.map(publicCandidateCore);
    const unavailableCount = candidates.filter((item) =>
      item.status === "qa_unavailable_retryable" || item.status === "qa_unavailable_terminal").length;
    const summary: S2PublicSummary = {
      kind: run.status !== "completed"
        ? "processing"
        : unavailableCount === candidates.length
          ? "all_results_unavailable"
          : unavailableCount > 0
            ? "results_include_unavailable"
            : "results_available",
      resultCount: candidates.filter((item) => terminal(item.status)).length,
      unavailableCount,
    };
    return {
      qaRun: {
        id: run.id,
        projectId: run.projectId,
        inputVersionId: run.inputVersionId,
        sourceGenerationSetId: run.sourceGenerationSetId,
        status: run.status,
        candidateResults: candidates,
        candidateAttempts,
        completedCandidateCount: run.completedCandidateCount,
        passCount: run.passCount,
        warningCount: run.warningCount,
        materialFailCount: run.materialFailCount,
        unavailableCount: run.unavailableCount,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        repairs: repairs.map(publicRepair),
        reQa: state.s2ReQaResults.filter((item) => item.qaRunId === run.id).map(publicReQa),
        summary,
      },
      input: { id: input.id },
    };
  }
  getQaRun(projectId: UUID, qaRunId: UUID): S2PublicQaProjection {
    const state = this.state(); this.project(state, projectId);
    const run = state.s2QaRuns.find((item) => item.id === qaRunId);
    if (!run || run.projectId !== projectId) throw fail(404, "QA_NOT_FOUND");
    return this.publicRun(state, run);
  }

  private startOperation(operationId: UUID): void {
    if (this.inFlight.has(operationId)) return;
    this.inFlight.add(operationId);
    void this.runOperation(operationId).catch(() => undefined).finally(() => this.inFlight.delete(operationId));
  }
  private runOperation(operationId: UUID): Promise<void> {
    const operation = this.state().s2Operations.find((item) => item.id === operationId);
    if (!operation) return Promise.resolve();
    if (operation.phase === "qa") return this.runQa(operationId);
    if (operation.phase === "repair") return this.runRepair(operationId);
    return this.runReQa(operationId);
  }
  private claim(operationId: UUID): { operation: S2Operation; token: UUID } | null {
    return this.repository.transact((state) => {
      const operation = state.s2Operations.find((item) => item.id === operationId);
      if (!operation || operation.status !== "queued") return null;
      const token = this.uuid();
      const run = state.s2QaRuns.find((item) => item.id === operation.qaRunId);
      const sourceResult = operation.phase === "qa"
        ? run?.candidateResults.find((item) => item.id === operation.resultId)
        : undefined;
      const reQaResult = operation.phase === "re_qa"
        ? state.s2ReQaResults.find((item) => item.id === operation.resultId)
        : undefined;
      const repair = operation.phase !== "qa" && operation.repairAttemptId
        ? state.s2Repairs.find((item) => item.id === operation.repairAttemptId)
        : undefined;
      const previousStatus = operation.phase === "qa" ? sourceResult?.status : operation.phase === "repair" ? repair?.status : reQaResult?.status;
      operation.status = "running"; operation.claimedBy = this.workerId; operation.claimedProcessId = this.processId;
      operation.claimToken = token; operation.claimedAt = this.clock(); operation.startedAt = this.clock();
      if (run && operation.phase === "qa") {
        if (sourceResult) {
          sourceResult.status = "running";
          sourceResult.startedAt = this.clock();
        }
        this.recompute(run);
      }
      if (operation.phase === "repair" && operation.repairAttemptId) {
        if (repair) { repair.status = "running"; repair.startedAt = this.clock(); }
      }
      if (operation.phase === "re_qa" && operation.repairAttemptId) {
        if (repair) repair.status = "re_qa_running";
        if (reQaResult) { reQaResult.status = "running"; reQaResult.startedAt = this.clock(); }
      }
      if (previousStatus !== undefined) {
        this.transition(state, operation.projectId, operation.id, operation.phase, operation.attempt, previousStatus, "running", operation.referenceId);
      }
      return { operation: cloneJson(operation), token };
    });
  }
  private sourceBytes(input: S2InputVersion, candidateId: UUID): Buffer {
    const source = input.sourceCandidates.find((item) => item.candidateId === candidateId);
    if (!source) throw fail(409, "QA_BINDING_CONFLICT");
    const bytes = this.objects.read(source.sourceStorageKey);
    if (bytes.byteLength !== source.sourceByteSize || sha256(bytes) !== source.sourceSha256) throw fail(409, "QA_BINDING_CONFLICT");
    return bytes;
  }
  private qaInput(input: S2InputVersion, candidateId: UUID, bytes: Uint8Array): S2QaProviderInput {
    const source = input.sourceCandidates.find((item) => item.candidateId === candidateId);
    if (!source) throw fail(409, "QA_BINDING_CONFLICT");
    return { sourceBytes: bytes, candidateId, candidateIndex: source.candidateIndex, geometrySnapshot: input.geometrySnapshot,
      requirements: input.canonicalRequirements, designRules: input.designRuleSnapshot.filter((item) => item.applicability === "applicable") };
  }
  private recompute(run: S2QaRun): void {
    const lifecycle = deriveSourceQaLifecycle(run.candidateResults, {
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    }, this.clock());
    run.status = lifecycle.status;
    run.startedAt = lifecycle.startedAt;
    run.completedAt = lifecycle.completedAt;
    run.completedCandidateCount = lifecycle.completedCandidateCount;
    run.passCount = lifecycle.passCount;
    run.warningCount = lifecycle.warningCount;
    run.materialFailCount = lifecycle.materialFailCount;
    run.unavailableCount = lifecycle.unavailableCount;
  }
  private async runQa(operationId: UUID): Promise<void> {
    const claim = this.claim(operationId); if (!claim) return;
    try {
      const state = this.state(); const run = state.s2QaRuns.find((item) => item.id === claim.operation.qaRunId);
      if (!run) throw fail(500, "PERSISTENCE_FAILED");
      const input = this.inputFor(state, run); const bytes = this.sourceBytes(input, claim.operation.candidateId);
      if (!this.provider.runS2Qa) throw new ProviderFailure("PROVIDER_NOT_CONFIGURED");
      await this.notifyDispatch("before-dispatch", claim.operation);
      const dispatched = this.beginProviderDispatch(operationId, claim.token);
      if (!dispatched) return;
      await this.notifyDispatch("after-dispatch-marked", dispatched);
      const response = await this.provider.runS2Qa(this.qaInput(input, claim.operation.candidateId, bytes));
      const value = evaluate(validateProvider(response.payload, input), input);
      this.repository.transact((current) => {
        const operation = current.s2Operations.find((item) => item.id === operationId);
        const currentRun = current.s2QaRuns.find((item) => item.id === claim.operation.qaRunId);
        const result = currentRun?.candidateResults.find((item) => item.id === claim.operation.resultId);
        if (!operation || !currentRun || !result || !this.claimMatches(operation, claim.token) || result.status !== "running") return;
        result.status = value.verdict === "PASS" ? "pass" : value.verdict === "WARNING" ? "warning" : "material_fail";
        result.verdict = value.verdict; result.requirementObservations = value.requirements; result.designObservations = value.designRules;
        result.materialFindingIds = value.material; result.warningFindingIds = value.warning; result.uncertainFindingIds = value.uncertain;
        result.providerRequestId = safeRequestId(response.providerRequestId); result.completedAt = this.clock();
        this.transition(current, operation.projectId, operation.id, operation.phase, operation.attempt, "running", result.status, operation.referenceId);
        operation.status = "succeeded"; operation.providerDispatchState = "consumed"; operation.completedAt = this.clock(); this.clearClaim(operation); this.recompute(currentRun);
      });
    } catch (error) {
      if (error instanceof ProcessInterruption) throw error;
      if (isQaCandidateFailure(error)) this.failQa(operationId, claim.token, error);
    }
  }
  private failQa(operationId: UUID, token: UUID, error: unknown): void {
    try {
      this.repository.transact((state) => {
        const operation = state.s2Operations.find((item) => item.id === operationId);
        const run = operation ? state.s2QaRuns.find((item) => item.id === operation.qaRunId) : null;
        const result = operation && run ? run.candidateResults.find((item) => item.id === operation.resultId) : null;
        if (!operation || !run || !result || !this.claimMatches(operation, token)) return;
        const canRetry = retryable(error) && operation.attempt === 1;
        result.status = canRetry ? "qa_unavailable_retryable" : "qa_unavailable_terminal";
        result.verdict = "QA_UNAVAILABLE"; result.completedAt = this.clock();
        this.transition(state, operation.projectId, operation.id, operation.phase, operation.attempt, "running", result.status, operation.referenceId);
        operation.status = "failed"; operation.providerDispatchState = "consumed"; operation.failureCode = error instanceof ProviderFailure ? error.safeCode : error instanceof AppError ? error.code : "QA_PROVIDER_FAILED";
        operation.completedAt = this.clock(); this.clearClaim(operation); this.recompute(run);
      });
    } catch { /* retain conservative durable state */ }
  }
  async retryQa(projectId: UUID, qaRunId: UUID, candidateId: UUID, key: UUID, referenceId: UUID): Promise<S2Mutation<Record<string, unknown>>> {
    const result = this.repository.transact((state) => {
      this.project(state, projectId); const run = state.s2QaRuns.find((item) => item.id === qaRunId);
      if (!run || run.projectId !== projectId) throw fail(404, "QA_NOT_FOUND");
      const current = this.latest(run, candidateId);
      const inputHash = operationInputHash("s2_qa_retry", projectId, { qaRunId, candidateId, expectedAttempt: 1 });
      if (this.idem(state, key, "s2_qa_retry", projectId, inputHash)) return { replayed: true };
      if (current.status !== "qa_unavailable_retryable") throw fail(409, run.candidateResults.some((item) => item.candidateId === candidateId && item.attempt === 2) ? "QA_RETRY_EXHAUSTED" : "QA_NOT_RETRYABLE");
      const input = this.inputFor(state, run); const source = input.sourceCandidates.find((item) => item.candidateId === candidateId);
      if (!source || source.sourceSha256 !== current.sourceSha256 || source.sourceByteSize !== current.sourceByteSize) throw fail(409, "QA_BINDING_CONFLICT");
      const retryResult: S2QaCandidateResult = { ...cloneJson(current), id: this.uuid(), attempt: 2, status: "queued", verdict: "QA_UNAVAILABLE",
        requirementObservations: [], designObservations: [], materialFindingIds: [], warningFindingIds: [], uncertainFindingIds: [],
        providerRequestId: null, repairAttemptId: null, startedAt: null, completedAt: null };
      const operationId = this.uuid(); run.candidateResults.push(retryResult);
      this.recompute(run);
      state.s2Operations.push({ id: operationId, projectId, phase: "qa", attempt: 2, qaRunId, candidateId, repairAttemptId: null,
        inputHash: input.inputHash, referenceId, status: "queued", claimedBy: null, claimedProcessId: null, claimToken: null,
        claimedAt: null, startedAt: null, completedAt: null, providerDispatchState: "not_started", failureCode: null, resultId: retryResult.id });
      this.transition(state, projectId, operationId, "qa", 2, current.status, "queued", referenceId);
      this.remember(state, key, "s2_qa_retry", projectId, inputHash, { qaRunId, candidateId, operationId, resultId: retryResult.id });
      return { replayed: false };
    });
    if (!result.replayed) {
      const operation = this.state().s2Operations.find((item) => item.qaRunId === qaRunId && item.candidateId === candidateId && item.attempt === 2 && item.phase === "qa");
      if (operation) this.startOperation(operation.id);
    }
    return { ...this.getQaRun(projectId, qaRunId), replayed: result.replayed };
  }

  private eligibleFindings(result: S2QaCandidateResult, input: S2InputVersion): string[] | null {
    return eligibleS2RepairFindingIds(result, input);
  }
  private eligible(result: S2QaCandidateResult, input: S2InputVersion): string[] {
    const ids = this.eligibleFindings(result, input);
    if (!ids) throw fail(409, "REPAIR_NOT_ELIGIBLE");
    return ids;
  }
  private repairImages(state: StoreState, input: S2InputVersion, candidateId: UUID): {
    images: Buffer[];
    referenceAssets: RepairAssetProjection[];
    logoAssets: RepairAssetProjection[];
  } {
    const source = input.sourceCandidates.find((item) => item.candidateId === candidateId);
    if (!source) throw fail(409, "QA_BINDING_CONFLICT");
    const images = [this.sourceBytes(input, candidateId)];
    const measures = [{ encodedBytes: source.sourceByteSize, width: source.sourceWidth, height: source.sourceHeight,
      pixelCount: source.sourcePixelCount, decodedRgbaBytes: source.sourceDecodedRgbaBytes }];
    const referenceAssets: RepairAssetProjection[] = [];
    const logoAssets: RepairAssetProjection[] = [];
    for (const [kind, ids] of [["reference", input.referenceAssetIds], ["logo", input.logoAssetIds]] as const) {
      ids.forEach((id, slot) => {
        const asset = state.s2Assets.find((item) => item.id === id);
        if (!asset || asset.kind !== kind || asset.status !== "ready") throw fail(409, "QA_BINDING_CONFLICT");
        const bytes = this.objects.read(asset.storageKeyNormalized);
        if (bytes.byteLength !== asset.normalizedBytes || sha256(bytes) !== asset.normalizedSha256) throw fail(409, "QA_BINDING_CONFLICT");
        const projection = repairAssetProjection(asset, slot + 1);
        (kind === "reference" ? referenceAssets : logoAssets).push(projection);
        images.push(bytes); measures.push({ ...s2NormalizedMeasure({ normalizedBytes: bytes, width: asset.width, height: asset.height }), encodedBytes: bytes.byteLength });
      });
    }
    if (images.length > S2_MAX_REPAIR_IMAGES) throw fail(422, "MEDIA_AGGREGATE_LIMIT_EXCEEDED");
    enforceS2AggregateLimits(measures, "assets", S2_MAX_REPAIR_IMAGES);
    return { images, referenceAssets, logoAssets };
  }
  async repairCandidate(projectId: UUID, qaRunId: UUID, candidateId: UUID, expectedInputVersionId: unknown, key: UUID, referenceId: UUID):
    Promise<S2Mutation<Record<string, unknown>>> {
    if (typeof expectedInputVersionId !== "string") throw fail(400, "INVALID_REQUEST");
    const result = this.repository.transact((state) => {
      this.project(state, projectId); const run = state.s2QaRuns.find((item) => item.id === qaRunId);
      if (!run || run.projectId !== projectId) throw fail(404, "QA_NOT_FOUND");
      if (run.inputVersionId !== expectedInputVersionId) throw fail(409, "QA_BINDING_CONFLICT");
      const input = this.inputFor(state, run); const current = this.latest(run, candidateId); const findings = this.eligible(current, input);
      const images = this.repairImages(state, input, candidateId);
      const source = input.sourceCandidates.find((item) => item.candidateId === candidateId);
      if (!source) throw fail(409, "QA_BINDING_CONFLICT");
      const operationHash = operationInputHash("s2_repair", projectId, {
        qaRunId, candidateId, expectedInputVersionId, eligibleFindingIds: findings,
      });
      if (this.idem(state, key, "s2_repair", projectId, operationHash)) return { replayed: true };
      if (state.s2Repairs.some((item) => item.qaRunId === qaRunId && item.candidateId === candidateId)) throw fail(409, "REPAIR_ALREADY_EXISTS");
      const repairHash = canonicalRepairInputHash(input, source, findings, images.referenceAssets, images.logoAssets);
      const prompt = renderS2RepairPrompt(input, source, findings, images.referenceAssets, images.logoAssets, repairHash);
      const repairId = this.uuid(); const operationId = this.uuid();
      const repair: S2RepairAttempt = { id: repairId, projectId, qaRunId, inputVersionId: input.id, candidateId, attempt: 1,
        status: "queued", eligibleFindingIds: findings, sourceAssetId: source.sourceAssetId, sourceByteSize: source.sourceByteSize,
        sourceSha256: source.sourceSha256, repairInputHash: repairHash, repairPromptHash: repairPromptHash(prompt), outputSha256: null,
        derivedCandidateId: null, reQaCandidateResultId: null, providerRequestId: null, createdAt: this.clock(), startedAt: null, completedAt: null };
      current.repairAttemptId = repairId; state.s2Repairs.push(repair);
      state.s2Operations.push({ id: operationId, projectId, phase: "repair", attempt: 1, qaRunId, candidateId,
        repairAttemptId: repairId, inputHash: operationHash, referenceId, status: "queued", claimedBy: null, claimedProcessId: null,
        claimToken: null, claimedAt: null, startedAt: null, completedAt: null, providerDispatchState: "not_started", failureCode: null, resultId: null });
      this.transition(state, projectId, operationId, "repair", 1, "eligible", "queued", referenceId);
      this.remember(state, key, "s2_repair", projectId, operationHash, { repairAttemptId: repairId, operationId });
      return { replayed: false };
    });
    if (!result.replayed) {
      const operation = this.state().s2Operations.find((item) => item.qaRunId === qaRunId && item.candidateId === candidateId && item.phase === "repair");
      if (operation) this.startOperation(operation.id);
    }
    return { ...this.getQaRun(projectId, qaRunId), replayed: result.replayed };
  }

  private async runRepair(operationId: UUID): Promise<void> {
    const claim = this.claim(operationId); if (!claim) return;
    let publication: S2RepairPublication | null = null;
    let staged: string | null = null;
    try {
      const state = this.state(); const operation = claim.operation;
      const repair = state.s2Repairs.find((item) => item.id === operation.repairAttemptId);
      const run = state.s2QaRuns.find((item) => item.id === operation.qaRunId);
      if (!repair || !run) throw fail(500, "PERSISTENCE_FAILED");
      const input = this.inputFor(state, run); const images = this.repairImages(state, input, operation.candidateId);
      const source = input.sourceCandidates.find((item) => item.candidateId === operation.candidateId);
      if (!source) throw fail(409, "QA_BINDING_CONFLICT");
      if (!this.provider.runS2Repair) throw new ProviderFailure("PROVIDER_NOT_CONFIGURED");
      await this.notifyDispatch("before-dispatch", claim.operation);
      const dispatched = this.beginProviderDispatch(operationId, claim.token);
      if (!dispatched) return;
      await this.notifyDispatch("after-dispatch-marked", dispatched);
      const dispatchInput = this.repairDispatchInput(operationId, claim.token);
      const response = await this.provider.runS2Repair({
        promptText: dispatchInput.promptText,
        images: dispatchInput.images,
      });
      assertS2Png(response.pngBytes, S2_MAX_REPAIR_OUTPUT_BYTES);
      const normalized = await normalizeS2Media({ kind: "reference", fileName: "provider-output.png", mimeType: "image/png",
        bytes: response.pngBytes, maxInputBytes: S2_MAX_REPAIR_OUTPUT_BYTES });
      staged = privateStorageKey("projects", operation.projectId, "s2", "repairs", repair.id, "staged", "provider-output.png");
      const finalKey = privateStorageKey("projects", operation.projectId, "s2", "repairs", repair.id, "output.png");
      const derived: S2DerivedCandidate = { id: this.uuid(), projectId: operation.projectId, sourceGenerationSetId: input.sourceGenerationSetId,
        inputVersionId: input.id, qaRunId: run.id, sourceCandidateId: source.candidateId, repairAttemptId: repair.id,
        sourceAssetId: source.sourceAssetId, sourceByteSize: source.sourceByteSize, sourceSha256: source.sourceSha256,
        outputSha256: normalized.normalizedSha256, normalizedBytes: normalized.normalizedBytes.byteLength,
        width: normalized.width, height: normalized.height, storageKeyNormalized: finalKey, createdAt: this.clock() };
      const reQaId = this.uuid(); const reQaOperationId = this.uuid();
      const reQa: S2ReQaResult = { id: reQaId, qaRunId: run.id, inputVersionId: input.id, candidateId: source.candidateId,
        candidateIndex: source.candidateIndex, attempt: 1, sourceAssetId: source.sourceAssetId, sourceByteSize: source.sourceByteSize,
        sourceSha256: source.sourceSha256, status: "queued", verdict: "QA_UNAVAILABLE", requirementObservations: [],
        designObservations: [], materialFindingIds: [], warningFindingIds: [], uncertainFindingIds: [], providerRequestId: null,
        repairAttemptId: repair.id, startedAt: null, completedAt: null, phase: "re_qa", derivedCandidateId: derived.id };
      const reQaOperation: S2Operation = { id: reQaOperationId, projectId: operation.projectId, phase: "re_qa", attempt: 1,
        qaRunId: run.id, candidateId: source.candidateId, repairAttemptId: repair.id, inputHash: input.inputHash,
        referenceId: operation.referenceId, status: "queued", claimedBy: null, claimedProcessId: null, claimToken: null,
        claimedAt: null, startedAt: null, completedAt: null, providerDispatchState: "not_started", failureCode: null, resultId: reQaId };
      publication = { kind: "repair_output", id: this.uuid(), projectId: operation.projectId, operationId,
        repairAttemptId: repair.id, qaRunId: run.id, candidateId: source.candidateId, inputVersionId: input.id, inputHash: operation.inputHash,
        stagingObjects: [{ key: staged, sha256: normalized.normalizedSha256, byteSize: normalized.normalizedBytes.byteLength }],
        finalObjects: [{ key: finalKey, sha256: normalized.normalizedSha256, byteSize: normalized.normalizedBytes.byteLength }],
        intendedDerived: derived, intendedReQa: reQa, intendedReQaOperation: reQaOperation,
        providerRequestId: safeRequestId(response.providerRequestId), state: "staged", createdAt: this.clock(), updatedAt: this.clock() };
      await this.notify("before-publication-intent", publication);
      this.repository.transact((current) => {
        const stored = current.s2Operations.find((item) => item.id === operationId);
        if (!stored || !this.claimMatches(stored, claim.token)) throw fail(409, "STATE_CONFLICT");
        current.s2Publications.push(cloneJson(publication!));
      });
      await this.notify("after-publication-intent", publication);
      this.objects.put(staged, normalized.normalizedBytes);
      this.verify(staged, normalized.normalizedBytes.byteLength, normalized.normalizedSha256);
      await this.notify("after-publication-staged", publication);
      this.objects.promote(staged, finalKey);
      this.verify(finalKey, normalized.normalizedBytes.byteLength, normalized.normalizedSha256);
      this.markPublication(publication.id, "promoted");
      await this.notify("after-final-promotion", publication);
      const committed = this.repository.transact((current) => {
        const stored = current.s2Publications.find((item) => item.id === publication!.id);
        const operationState = current.s2Operations.find((item) => item.id === operationId);
        if (!stored || !operationState || !this.claimMatches(operationState, claim.token)) return false;
        if (stored.state !== "promoted") throw fail(500, "PERSISTENCE_FAILED");
        this.commitRepairPublication(current, stored as S2RepairPublication);
        stored.state = "committed"; stored.updatedAt = this.clock(); return true;
      });
      if (!committed) { this.cleanup(publication); return; }
      this.cleanup(publication);
      const next = this.state().s2Operations.find((item) => item.id === reQaOperationId);
      if (next) this.startOperation(next.id);
    } catch (error) {
      if (error instanceof ProcessInterruption) throw error;
      if (publication) {
        let owned = false;
        try { owned = this.abortRepairPublicationIfOwned(publication.id, operationId, claim.token); } catch { /* recovery remains conservative */ }
        if (owned) this.cleanup(publication);
      } else if (staged) {
        this.objects.remove(staged);
      }
      this.failRepair(operationId, claim.token, error);
    }
  }

  private repairDispatchInput(operationId: UUID, token: UUID): {
    promptText: string;
    images: Buffer[];
  } {
    const state = this.state();
    const operation = state.s2Operations.find((item) => item.id === operationId);
    if (!operation || !this.claimMatches(operation, token) || operation.phase !== "repair" || !operation.repairAttemptId) {
      throw fail(409, "STATE_CONFLICT");
    }
    const repair = state.s2Repairs.find((item) => item.id === operation.repairAttemptId);
    const run = state.s2QaRuns.find((item) => item.id === operation.qaRunId);
    if (!repair || !run) throw fail(500, "PERSISTENCE_FAILED");
    const input = this.inputFor(state, run);
    const source = input.sourceCandidates.find((item) => item.candidateId === operation.candidateId);
    if (!source) throw fail(409, "QA_BINDING_CONFLICT");
    const latest = this.latest(run, operation.candidateId);
    const eligible = eligibleS2RepairFindingIds(latest, input);
    if (!eligible || !equalIds(eligible, repair.eligibleFindingIds)) throw fail(500, "PERSISTENCE_FAILED");
    const images = this.repairImages(state, input, operation.candidateId);
    const expectedInputHash = canonicalRepairInputHash(input, source, eligible, images.referenceAssets, images.logoAssets);
    if (expectedInputHash !== repair.repairInputHash) throw fail(500, "PERSISTENCE_FAILED");
    const promptText = renderS2RepairPrompt(input, source, eligible, images.referenceAssets, images.logoAssets, repair.repairInputHash);
    if (repairPromptHash(promptText) !== repair.repairPromptHash) throw fail(500, "PERSISTENCE_FAILED");
    return { promptText, images: images.images };
  }

  private failRepair(operationId: UUID, token: UUID, error: unknown): void {
    try {
      this.repository.transact((state) => {
        const operation = state.s2Operations.find((item) => item.id === operationId);
        const repair = operation?.repairAttemptId ? state.s2Repairs.find((item) => item.id === operation.repairAttemptId) : null;
        if (!operation || !repair || !this.claimMatches(operation, token)) return;
        repair.status = "failed"; repair.completedAt = this.clock();
        this.transition(state, operation.projectId, operation.id, operation.phase, operation.attempt, "running", "failed", operation.referenceId);
        operation.status = "failed"; operation.providerDispatchState = "consumed"; operation.failureCode = error instanceof AppError ? error.code :
          error instanceof ProviderFailure ? error.safeCode : "REPAIR_PROVIDER_FAILED";
        operation.completedAt = this.clock(); this.clearClaim(operation);
      });
    } catch { /* no derived success after uncertain persistence */ }
  }
  private async runReQa(operationId: UUID): Promise<void> {
    const claim = this.claim(operationId); if (!claim) return;
    try {
      const state = this.state(); const operation = claim.operation;
      const repair = state.s2Repairs.find((item) => item.id === operation.repairAttemptId);
      const derived = repair?.derivedCandidateId ? state.s2DerivedCandidates.find((item) => item.id === repair.derivedCandidateId) : null;
      const run = state.s2QaRuns.find((item) => item.id === operation.qaRunId);
      const result = state.s2ReQaResults.find((item) => item.id === operation.resultId);
      if (!repair || !derived || !run || !result) throw fail(500, "PERSISTENCE_FAILED");
      const input = this.inputFor(state, run); const bytes = this.objects.read(derived.storageKeyNormalized);
      if (bytes.byteLength !== derived.normalizedBytes || sha256(bytes) !== derived.outputSha256) throw fail(503, "RE_QA_UNAVAILABLE");
      if (!this.provider.runS2Qa) throw new ProviderFailure("PROVIDER_NOT_CONFIGURED");
      await this.notifyDispatch("before-dispatch", claim.operation);
      const dispatched = this.beginProviderDispatch(operationId, claim.token);
      if (!dispatched) return;
      await this.notifyDispatch("after-dispatch-marked", dispatched);
      const response = await this.provider.runS2Qa(this.qaInput(input, operation.candidateId, bytes));
      const value = evaluate(validateProvider(response.payload, input), input);
      this.repository.transact((current) => {
        const stored = current.s2Operations.find((item) => item.id === operationId);
        const storedResult = current.s2ReQaResults.find((item) => item.id === operation.resultId);
        const storedRepair = stored?.repairAttemptId ? current.s2Repairs.find((item) => item.id === stored.repairAttemptId) : null;
        if (!stored || !storedResult || !storedRepair || !this.claimMatches(stored, claim.token)) return;
        storedResult.status = value.verdict === "PASS" ? "pass" : value.verdict === "WARNING" ? "warning" : "material_fail";
        storedResult.verdict = value.verdict; storedResult.requirementObservations = value.requirements;
        storedResult.designObservations = value.designRules; storedResult.materialFindingIds = value.material;
        storedResult.warningFindingIds = value.warning; storedResult.uncertainFindingIds = value.uncertain;
        storedResult.providerRequestId = safeRequestId(response.providerRequestId); storedResult.completedAt = this.clock();
        storedRepair.status = value.verdict === "PASS" ? "re_qa_pass" : value.verdict === "WARNING" ? "re_qa_warning" : "re_qa_material_fail";
        storedRepair.completedAt = this.clock(); stored.status = "succeeded"; stored.providerDispatchState = "consumed";
        this.transition(current, stored.projectId, stored.id, stored.phase, stored.attempt, "running", storedRepair.status, stored.referenceId);
        stored.completedAt = this.clock(); this.clearClaim(stored);
      });
    } catch (error) {
      if (error instanceof ProcessInterruption) throw error;
      if (!isReQaCandidateFailure(error)) return;
      try {
        this.repository.transact((state) => {
          const operation = state.s2Operations.find((item) => item.id === operationId);
          const result = operation?.resultId ? state.s2ReQaResults.find((item) => item.id === operation.resultId) : null;
          const repair = operation?.repairAttemptId ? state.s2Repairs.find((item) => item.id === operation.repairAttemptId) : null;
          if (!operation || !result || !repair || !this.claimMatches(operation, claim.token)) return;
          result.status = "re_qa_unavailable"; result.verdict = "QA_UNAVAILABLE"; result.completedAt = this.clock();
          repair.status = "re_qa_unavailable"; repair.completedAt = this.clock();
          this.transition(state, operation.projectId, operation.id, operation.phase, operation.attempt, "running", "re_qa_unavailable", operation.referenceId);
          operation.status = "failed"; operation.providerDispatchState = "consumed";
          operation.failureCode = error instanceof AppError ? error.code :
            error instanceof ProviderFailure ? error.safeCode : "RE_QA_UNAVAILABLE";
          operation.completedAt = this.clock(); this.clearClaim(operation);
        });
      } catch { /* keep the last durable state */ }
    }
  }
}
