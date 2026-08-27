import type {
  BoothGeometry,
  S2CandidateSource,
  S2DesignObservation,
  S2DesignRuleSnapshot,
  S2InputVersion,
  S2QaCandidateResult,
  S2QaRun,
  S2ReferenceDraft,
  S2RepairAttempt,
  S2Requirement,
  S2RequirementObservation,
  S2ReQaResult,
  S2DerivedCandidate,
  S2Operation,
  S2PublicationObject,
  S2RepairPublication,
  S2UploadPublication,
  StoreState,
  StructuredBriefData,
} from "./types";
import { jcs, sha256, uuidV4Pattern } from "./utils";
import {
  latestSourceQaResults,
  SOURCE_QA_CANDIDATE_INDEXES,
  SOURCE_QA_TERMINAL_STATUSES,
} from "./s2-lifecycle";

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_REFERENCES = 6;
const MAX_LOGOS = 2;
const MAX_TOTAL_ASSETS = 8;
const QA_MODEL = "gpt-5.4-mini-2026-03-17";
const QA_SCHEMA = "s2-qa-v1";
const DESIGN_RULES_VERSION = "s2-design-rules-v1";
const DECODER_PROFILE = "s2-media-v1";

const SOURCE_INDEXES = SOURCE_QA_CANDIDATE_INDEXES;
const TERMINAL_CANDIDATE_STATUSES = SOURCE_QA_TERMINAL_STATUSES;
const UNAVAILABLE_STATUSES = ["qa_unavailable_retryable", "qa_unavailable_terminal", "re_qa_unavailable"] as const;
const RETRYABLE_QA_FAILURE_CODES = new Set([
  "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMIT", "PROVIDER_SERVER_ERROR", "QA_PROVIDER_INCOMPLETE",
]);

type AnyRecord = Record<string, unknown>;
type S2TransitionRecord = StoreState["s2Transitions"][number];

function invalid(reason: string): never {
  throw new Error("invalid S2 persisted graph: " + reason);
}

function ensure(condition: unknown, reason: string): asserts condition {
  if (!condition) invalid(reason);
}

function required<T>(value: T | undefined | null, reason: string): T {
  if (value === undefined || value === null) invalid(reason);
  return value;
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function equalJson(left: unknown, right: unknown): boolean {
  return jcs(left) === jcs(right);
}

function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function uniqueBy<T>(values: readonly T[], id: (value: T) => string, name: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const valueId = id(value);
    ensure(typeof valueId === "string" && valueId.length > 0, name + ".id");
    ensure(!result.has(valueId), name + ".duplicate-id");
    result.set(valueId, value);
  }
  return result;
}

function exactKeys(value: AnyRecord, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => expected.has(key));
}

function operationInputHash(operation: string, projectId: string, input: unknown): string {
  return sha256(jcs({ operation, projectId, input }));
}

function sourceProjection(source: S2CandidateSource): AnyRecord {
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

function rulesFor(geometry: BoothGeometry): S2DesignRuleSnapshot[] {
  return RULE_CATALOGUE.map((rule) => ({ ...rule,
    applicability: rule.ruleId === "geometry.max-height" && geometry.maxHeightMm === null ? "not_applicable" : "applicable",
  }));
}

const REPAIR_FINDING_FAMILY_ORDER: Readonly<Record<string, number>> = {
  "footprint.within-boundary": 1,
  "access.open-sides": 2,
  "circulation.primary-access": 3,
  "zones.inside-footprint": 4,
  "structure.no-floating": 5,
  "structure.screen-support": 6,
  "structure.overhead-support": 7,
  "scale.human": 8,
  "geometry.intersections": 9,
  "branding.prohibited": 10,
};

function findingOrder(id: string): { family: number; item: number } | null {
  const fixed = REPAIR_FINDING_FAMILY_ORDER[id];
  if (fixed !== undefined) return { family: fixed, item: 0 };
  const functional = /^brief\.functional\.(\d{3})$/.exec(id);
  if (functional) return { family: 11, item: Number(functional[1]) };
  const mandatory = /^brief\.mandatory\.(\d{3})$/.exec(id);
  if (mandatory) return { family: 12, item: Number(mandatory[1]) };
  return null;
}

function orderedFindings(ids: readonly string[]): string[] | null {
  if (new Set(ids).size !== ids.length) return null;
  const entries = ids.map((id) => ({ id, order: findingOrder(id) }));
  if (entries.some((entry) => entry.order === null)) return null;
  entries.sort((left, right) => left.order!.family - right.order!.family || left.order!.item - right.order!.item);
  return entries.map((entry) => entry.id);
}

function selectedAssetProjection(state: StoreState, ids: readonly string[], kind: "reference" | "logo", projectId: string): AnyRecord[] {
  return ids.map((assetId, index) => {
    const asset = required(state.s2Assets.find((item) => item.id === assetId), "selected-asset.exists");
    ensure(asset.projectId === projectId && asset.kind === kind && asset.status === "ready", "selected-asset.owner-kind-status");
    return { assetId, normalizedSha256: asset.normalizedSha256, width: asset.width, height: asset.height,
      normalizedBytes: asset.normalizedBytes, slot: index + 1 };
  });
}

function repairInputHash(
  input: S2InputVersion,
  source: S2CandidateSource,
  findingIds: readonly string[],
  referenceAssets: readonly AnyRecord[],
  logoAssets: readonly AnyRecord[],
): string {
  return sha256(jcs({
    schemaVersion: "s2-repair-v1",
    inputVersionId: input.id,
    qaRunId: input.qaRunId,
    candidateId: source.candidateId,
    sourceAssetId: source.sourceAssetId,
    sourceSha256: source.sourceSha256,
    sourceByteSize: source.sourceByteSize,
    sourceWidth: source.sourceWidth,
    sourceHeight: source.sourceHeight,
    sourcePixelCount: source.sourcePixelCount,
    sourceDecodedRgbaBytes: source.sourceDecodedRgbaBytes,
    bindingHash: input.bindingHash,
    orderedFindingIds: findingIds,
    referenceAssets,
    logoAssets,
    confirmedBriefContentHash: input.confirmedBriefContentHash,
    geometryHash: input.geometryHash,
    attempt: 1,
  }));
}

function candidateEligibility(result: S2QaCandidateResult, input: S2InputVersion): string[] | null {
  if (result.status !== "material_fail" || result.verdict !== "MATERIAL_FAIL" || result.uncertainFindingIds.length ||
      result.materialFindingIds.length < 1 || result.materialFindingIds.length > 3) return null;
  const ids = orderedFindings(result.materialFindingIds);
  if (!ids) return null;
  const rules = new Map(input.designRuleSnapshot.map((item) => [item.ruleId, item]));
  const requirements = new Map(input.canonicalRequirements.map((item) => [item.requirementId, item]));
  if (ids.some((id) => {
    const rule = rules.get(id); const requirement = requirements.get(id);
    return (rule && (!rule.repairable || rule.applicability !== "applicable")) ||
      (requirement && requirement.criticality !== "material") || (!rule && !requirement) ||
      (!rule && !/^brief\.(functional|mandatory)\.\d{3}$/.test(id));
  })) return null;
  if (ids.filter((id) => /^brief\.(functional|mandatory)\.\d{3}$/.test(id)).length > 1) return null;
  return ids;
}

function validateObservationSet(result: S2QaCandidateResult | S2ReQaResult, input: S2InputVersion): void {
  const isUnavailable = (UNAVAILABLE_STATUSES as readonly string[]).includes(result.status);
  const isTerminal = (TERMINAL_CANDIDATE_STATUSES as readonly string[]).includes(result.status);
  ensure(isTerminal || result.status === "queued" || result.status === "running" || isUnavailable, "candidate.status");
  if (result.status === "queued" || result.status === "running" || isUnavailable) {
    ensure(result.requirementObservations.length === 0 && result.designObservations.length === 0, "candidate.nonterminal-observations");
    ensure(result.materialFindingIds.length === 0 && result.warningFindingIds.length === 0 && result.uncertainFindingIds.length === 0, "candidate.nonterminal-findings");
    ensure(result.verdict === "QA_UNAVAILABLE", "candidate.nonterminal-verdict");
  } else {
    const material: string[] = [];
    const warning: string[] = [];
    const uncertain: string[] = [];
    ensure(result.requirementObservations.length === input.canonicalRequirements.length, "candidate.requirement-cardinality");
    input.canonicalRequirements.forEach((expected, index) => {
      const observed = result.requirementObservations[index];
      ensure(observed.requirementId === expected.requirementId && observed.expected === expected.expected &&
        observed.expectedCount === expected.expectedCount, "candidate.requirement-order");
      if (expected.expected !== "exact_count") ensure(observed.observedCount === null, "candidate.requirement-observed-count");
      if (expected.expected === "exact_count" && (observed.observed === "present" || observed.observed === "absent") && observed.confidence >= 0.75) {
        ensure(observed.observedCount !== null, "candidate.exact-count-observation");
      }
      const isUncertain = observed.confidence < 0.75 || observed.observed === "uncertain" || observed.observed === "not_verifiable";
      let violation = false;
      if (!isUncertain) {
        violation = (expected.expected === "present" && observed.observed === "absent") ||
          (expected.expected === "absent" && observed.observed === "present") ||
          (expected.expected === "exact_count" && observed.observedCount !== expected.expectedCount);
      }
      if (isUncertain) uncertain.push("uncertain:" + expected.requirementId);
      if (violation) (expected.criticality === "material" ? material : warning).push(expected.requirementId);
    });
    const applicableRules = input.designRuleSnapshot.filter((item) => item.applicability === "applicable");
    ensure(result.designObservations.length === applicableRules.length, "candidate.design-cardinality");
    applicableRules.forEach((expected, index) => {
      const observed = result.designObservations[index];
      ensure(observed.ruleId === expected.ruleId, "candidate.design-order");
      const isUncertain = observed.confidence < 0.75 || observed.observed === "uncertain" || observed.observed === "not_verifiable";
      if (isUncertain) uncertain.push("uncertain:" + expected.ruleId);
      if (!isUncertain && observed.observed === "non_compliant") (expected.materiality === "material" ? material : warning).push(expected.ruleId);
    });
    ensure(equalIds(result.materialFindingIds, material), "candidate.material-findings");
    ensure(equalIds(result.warningFindingIds, warning), "candidate.warning-findings");
    ensure(equalIds(result.uncertainFindingIds, uncertain), "candidate.uncertain-findings");
    if (result.status === "pass") ensure(result.verdict === "PASS" && material.length === 0 && warning.length === 0 && uncertain.length === 0, "candidate.pass-tuple");
    if (result.status === "warning") ensure(result.verdict === "WARNING" && material.length === 0 && (warning.length > 0 || uncertain.length > 0), "candidate.warning-tuple");
    if (result.status === "material_fail") ensure(result.verdict === "MATERIAL_FAIL" && material.length > 0, "candidate.material-tuple");
  }
  if (result.status === "queued") ensure(result.startedAt === null && result.completedAt === null, "candidate.queued-time");
  if (result.status === "running") ensure(result.startedAt !== null && result.completedAt === null, "candidate.running-time");
  if (isTerminal || isUnavailable) ensure(result.startedAt !== null && result.completedAt !== null, "candidate.terminal-time");
}

function validateSourceLineage(state: StoreState, input: S2InputVersion, projects: Map<string, StoreState["projects"][number]>, generationSets: Map<string, StoreState["generationSets"][number]>, briefVersions: Map<string, StoreState["briefVersions"][number]>): void {
  const project = required(projects.get(input.projectId), "input.project");
  const generationSet = generationSets.get(input.sourceGenerationSetId);
  ensure(generationSet !== undefined && generationSet.projectId === input.projectId && generationSet.status === "succeeded" &&
    generationSet.expectedCandidateCount === 4 && project.activeGenerationSetId === input.sourceGenerationSetId, "input.generation-set");
  const brief = required(briefVersions.get(input.confirmedBriefVersionId), "input.brief");
  ensure(brief.projectId === input.projectId && brief.status === "confirmed" &&
    project.confirmedBriefVersionId === input.confirmedBriefVersionId && input.confirmedBriefContentHash === brief.contentHash, "input.brief");
  ensure(input.sourceCandidates.length === 4, "input.source-cardinality");
  const candidates = uniqueBy(state.candidates.filter((item) => item.generationSetId === input.sourceGenerationSetId), (item) => item.candidateId, "s1-candidate");
  const assets = uniqueBy(state.conceptAssets.filter((item) => item.generationSetId === input.sourceGenerationSetId), (item) => item.assetId, "s1-concept-asset");
  input.sourceCandidates.forEach((source, index) => {
    ensure(source.candidateIndex === SOURCE_INDEXES[index], "input.source-order");
    const candidate = required(candidates.get(source.candidateId), "input.source-candidate");
    ensure(candidate.projectId === input.projectId && candidate.generationSetId === input.sourceGenerationSetId &&
      candidate.confirmedBriefVersionId === input.confirmedBriefVersionId && candidate.candidateIndex === source.candidateIndex && candidate.assetId === source.sourceAssetId, "input.source-candidate-lineage");
    const asset = required(assets.get(source.sourceAssetId), "input.source-asset");
    ensure(asset.projectId === input.projectId && asset.generationSetId === input.sourceGenerationSetId &&
      asset.status === "stored" && asset.mimeType === "image/png" && source.sourceStorageKey === asset.storageKey &&
      source.sourceSha256 === asset.sha256 && source.sourceByteSize === asset.byteSize, "input.source-asset-lineage");
  });
  ensure(equalJson(input.geometrySnapshot, brief.geometrySnapshot), "input.geometry-snapshot");
  ensure(input.geometryHash === sha256(jcs(input.geometrySnapshot)), "input.geometry-hash");
  const requirements = requirementsFor(brief.data, input.geometrySnapshot);
  const rules = rulesFor(input.geometrySnapshot);
  ensure(equalJson(input.canonicalRequirements, requirements), "input.requirements-snapshot");
  ensure(input.requirementHash === sha256(jcs({ schemaVersion: "s2-requirements-v1", requirements })), "input.requirement-hash");
  ensure(equalJson(input.designRuleSnapshot, rules), "input.rules-snapshot");
  ensure(input.designRulesVersion === DESIGN_RULES_VERSION && input.decoderProfile === DECODER_PROFILE &&
    input.qaModel === QA_MODEL && input.qaSchema === QA_SCHEMA, "input.schema-tuple");
  const draft = required(state.s2Drafts.find((item) => item.projectId === input.projectId), "input.draft");
  ensure(draft.status === "frozen" && draft.revision === input.draftRevision &&
    equalIds(draft.referenceAssetIds, input.referenceAssetIds) && equalIds(draft.logoAssetIds, input.logoAssetIds), "input.draft-bind");
  const referenceAssets = selectedAssetProjection(state, input.referenceAssetIds, "reference", input.projectId);
  const logoAssets = selectedAssetProjection(state, input.logoAssetIds, "logo", input.projectId);
  const sourceCandidates = input.sourceCandidates.map(sourceProjection);
  const expectedInputHash = sha256(jcs({ schemaVersion: "s2-input-v1", sourceGenerationSetId: input.sourceGenerationSetId, sourceCandidates,
    confirmedBriefVersionId: input.confirmedBriefVersionId, confirmedBriefContentHash: input.confirmedBriefContentHash,
    geometryHash: input.geometryHash, requirementHash: input.requirementHash, designRulesVersion: DESIGN_RULES_VERSION,
    designRuleSnapshot: rules, decoderProfile: DECODER_PROFILE, qaModel: QA_MODEL, qaSchema: QA_SCHEMA, referenceAssets, logoAssets }));
  ensure(input.inputHash === expectedInputHash, "input.input-hash");
  const expectedBindingHash = sha256(jcs({ schemaVersion: "s2-binding-v1", projectId: input.projectId,
    sourceGenerationSetId: input.sourceGenerationSetId, draftRevision: input.draftRevision, inputHash: input.inputHash,
    sourceCandidates, referenceAssets, logoAssets }));
  ensure(input.bindingHash === expectedBindingHash, "input.binding-hash");
}

function validateRunResultLineage(result: S2QaCandidateResult, run: S2QaRun, input: S2InputVersion, resultIds: Set<string>): void {
  ensure(!resultIds.has(result.id), "qa-result.duplicate-id");
  resultIds.add(result.id);
  const source = input.sourceCandidates.find((item) => item.candidateId === result.candidateId);
  ensure(source !== undefined && result.qaRunId === run.id && result.inputVersionId === input.id &&
    result.candidateIndex === source.candidateIndex && result.sourceAssetId === source.sourceAssetId &&
    result.sourceByteSize === source.sourceByteSize && result.sourceSha256 === source.sourceSha256, "qa-result.source-lineage");
  if (result.attempt === 2) ensure(result.status !== "qa_unavailable_retryable", "qa-result.attempt-two-retryable");
  validateObservationSet(result, input);
}

function validateRunRetryTopology(
  run: S2QaRun,
  input: S2InputVersion,
  operations: Map<string, S2Operation>,
  idempotency: Map<string, StoreState["idempotency"][number]>,
): void {
  const attemptOne = run.candidateResults.filter((item) => item.attempt === 1);
  const attemptTwo = run.candidateResults.filter((item) => item.attempt === 2);
  ensure(attemptOne.length === 4 && attemptOne.every((item, index) => item.candidateIndex === SOURCE_INDEXES[index]), "qa-run.initial-topology");
  const sources = SOURCE_INDEXES.map((index) => {
    const source = input.sourceCandidates[index - 1];
    ensure(source !== undefined && source.candidateIndex === index, "qa-run.canonical-source");
    return source;
  });
  ensure(new Set(sources.map((source) => source.candidateId)).size === sources.length, "qa-run.canonical-source-unique");

  for (const source of sources) {
    const initial = attemptOne.filter((item) => item.candidateId === source.candidateId);
    ensure(initial.length === 1, "qa-run.initial-cardinality");
    const first = initial[0];
    ensure(first.candidateId === source.candidateId && first.candidateIndex === source.candidateIndex &&
      first.sourceAssetId === source.sourceAssetId && first.sourceByteSize === source.sourceByteSize && first.sourceSha256 === source.sourceSha256, "qa-run.initial-lineage");
    const retries = attemptTwo.filter((item) => item.candidateId === source.candidateId);
    ensure(retries.length <= 1, "qa-run.retry-cardinality");
    if (retries.length === 0) continue;

    const retry = retries[0];
    ensure(first.status === "qa_unavailable_retryable", "qa-run.retry-eligibility");
    ensure(retry.status !== "qa_unavailable_retryable", "qa-run.retry-attempt-two-status");
    ensure(retry.qaRunId === run.id && retry.inputVersionId === input.id && retry.candidateId === first.candidateId &&
      retry.candidateIndex === first.candidateIndex && retry.sourceAssetId === first.sourceAssetId &&
      retry.sourceByteSize === first.sourceByteSize && retry.sourceSha256 === first.sourceSha256, "qa-run.retry-lineage");

    const initialOperations = Array.from(operations.values()).filter((operation) => operation.phase === "qa" && operation.qaRunId === run.id &&
      operation.attempt === 1 && operation.resultId === first.id);
    ensure(initialOperations.length === 1, "qa-run.retry-initial-operation");
    const initialOperation = initialOperations[0];
    ensure(initialOperation.status === "failed" && initialOperation.providerDispatchState === "consumed" &&
      initialOperation.failureCode !== null && RETRYABLE_QA_FAILURE_CODES.has(initialOperation.failureCode), "qa-run.retry-initial-failure");

    const retryOperations = Array.from(operations.values()).filter((operation) => operation.phase === "qa" && operation.qaRunId === run.id &&
      operation.attempt === 2 && operation.resultId === retry.id);
    ensure(retryOperations.length === 1, "qa-run.retry-operation-cardinality");
    const retryOperation = retryOperations[0];
    ensure(retryOperation.projectId === run.projectId && retryOperation.candidateId === source.candidateId &&
      retryOperation.resultId === retry.id && retryOperation.inputHash === input.inputHash, "qa-run.retry-operation-lineage");

    const retryRecords = Array.from(idempotency.values()).filter((record) => {
      if (record.operation !== "s2_qa_retry" || !isRecord(record.result)) return false;
      return record.result.qaRunId === run.id && record.result.resultId === retry.id;
    });
    ensure(retryRecords.length === 1, "qa-run.retry-idempotency-cardinality");
    const retryIdentity = retryRecords[0].result as AnyRecord;
    ensure(retryRecords[0].projectId === run.projectId && retryIdentity.qaRunId === run.id &&
      retryIdentity.candidateId === source.candidateId && retryIdentity.operationId === retryOperation.id && retryIdentity.resultId === retry.id, "qa-run.retry-idempotency-lineage");
  }
}

function validateRunLifecycle(run: S2QaRun, latest: readonly S2QaCandidateResult[]): void {
  const hasQueued = latest.some((item) => item.status === "queued");
  const hasRunning = latest.some((item) => item.status === "running");
  const allTerminal = latest.length === SOURCE_INDEXES.length &&
    latest.every((item) => (TERMINAL_CANDIDATE_STATUSES as readonly string[]).includes(item.status));
  const sourceHasStarted = run.startedAt !== null || latest.some((item) =>
    item.attempt === 2 ||
    item.status !== "queued" ||
    item.startedAt !== null ||
    item.completedAt !== null,
  );

  // Counters are calculated from the canonical latest result per candidate only.
  ensure(run.completedCandidateCount === latest.filter((item) =>
    (TERMINAL_CANDIDATE_STATUSES as readonly string[]).includes(item.status),
  ).length, "qa-run.completed-count");
  ensure(run.passCount === latest.filter((item) => item.status === "pass").length &&
    run.warningCount === latest.filter((item) => item.status === "warning").length &&
    run.materialFailCount === latest.filter((item) => item.status === "material_fail").length &&
    run.unavailableCount === latest.filter((item) =>
      item.status === "qa_unavailable_retryable" || item.status === "qa_unavailable_terminal",
    ).length, "qa-run.counters");

  // This expected-state calculation is deliberately independent of the runtime
  // projection helper. It rejects reverse lifecycle tuples on persisted load.
  if (run.status === "queued") {
    ensure(!sourceHasStarted && latest.length === SOURCE_INDEXES.length &&
      latest.every((item) => item.status === "queued") &&
      !hasRunning && run.startedAt === null && run.completedAt === null, "qa-run.queued-tuple");
  } else if (run.status === "running") {
    ensure(sourceHasStarted && run.startedAt !== null && run.completedAt === null &&
      !allTerminal && (hasQueued || hasRunning || latest.some((item) =>
        (TERMINAL_CANDIDATE_STATUSES as readonly string[]).includes(item.status),
      )), "qa-run.running-tuple");
  } else if (run.status === "completed") {
    ensure(allTerminal && run.startedAt !== null && run.completedAt !== null, "qa-run.completed-tuple");
  } else if (run.status === "failed") {
    // A failed run is reserved for a run-level persistence/invariant failure;
    // provider failures are represented by terminal unavailable candidates.
    ensure(allTerminal && run.startedAt !== null && run.completedAt !== null, "qa-run.failed-tuple");
  } else {
    invalid("qa-run.status");
  }
}

function validateRepairSource(repair: S2RepairAttempt, input: S2InputVersion): S2CandidateSource {
  const source = input.sourceCandidates.find((item) => item.candidateId === repair.candidateId);
  ensure(source !== undefined && repair.projectId === input.projectId && repair.qaRunId === input.qaRunId && repair.inputVersionId === input.id &&
    repair.sourceAssetId === source.sourceAssetId && repair.sourceByteSize === source.sourceByteSize && repair.sourceSha256 === source.sourceSha256, "repair.source-lineage");
  return required(source, "repair.source");
}

function validateRepairState(repair: S2RepairAttempt, run: S2QaRun, input: S2InputVersion, state: StoreState, operations: Map<string, S2Operation>, derived: Map<string, S2DerivedCandidate>, reQa: Map<string, S2ReQaResult>): void {
  const source = validateRepairSource(repair, input);
  const history = run.candidateResults
    .filter((item) => item.candidateId === repair.candidateId)
    .slice()
    .sort((left, right) => left.attempt - right.attempt);
  const latest = latestSourceQaResults(history)[0];
  ensure(latest !== undefined && latest.repairAttemptId === repair.id, "repair.latest-link");
  ensure(history.filter((item) => item.id !== latest.id).every((item) => item.repairAttemptId === null), "repair.earlier-link");
  const eligible = candidateEligibility(latest, input);
  ensure(eligible !== null && equalIds(repair.eligibleFindingIds, eligible), "repair.eligible-findings");
  const referenceAssets = selectedAssetProjection(state, input.referenceAssetIds, "reference", input.projectId);
  const logoAssets = selectedAssetProjection(state, input.logoAssetIds, "logo", input.projectId);
  ensure(repair.repairInputHash === repairInputHash(input, source, repair.eligibleFindingIds, referenceAssets, logoAssets), "repair.input-hash");
  const repairOperation = Array.from(operations.values()).find((item) => item.phase === "repair" && item.repairAttemptId === repair.id);
  const repairDerived = repair.derivedCandidateId ? derived.get(repair.derivedCandidateId) : undefined;
  const repairReQa = repair.reQaCandidateResultId ? reQa.get(repair.reQaCandidateResultId) : undefined;
  const reQaOperation = Array.from(operations.values()).find((item) => item.phase === "re_qa" && item.repairAttemptId === repair.id);
  const preDerived = repair.status === "not_eligible" || repair.status === "eligible" || repair.status === "queued" || repair.status === "running" || repair.status === "failed";
  if (repair.status === "not_eligible") {
    ensure(eligible === null && repair.eligibleFindingIds.length === 0, "repair.not-eligible-findings");
    ensure(repair.derivedCandidateId === null && repair.reQaCandidateResultId === null && repair.outputSha256 === null, "repair.not-eligible-output");
    ensure(repairOperation === undefined && reQaOperation === undefined && repair.providerRequestId === null && repair.startedAt === null && repair.completedAt !== null, "repair.not-eligible-tuple");
    return;
  }
  ensure(eligible !== null && equalIds(repair.eligibleFindingIds, eligible), "repair.eligible-findings");
  if (repair.status === "eligible") {
    ensure(repair.derivedCandidateId === null && repair.reQaCandidateResultId === null && repair.outputSha256 === null, "repair.eligible-output");
    ensure(repairOperation === undefined && reQaOperation === undefined && repair.providerRequestId === null && repair.startedAt === null && repair.completedAt === null, "repair.eligible-tuple");
    return;
  }
  if (preDerived) {
    ensure(repair.derivedCandidateId === null && repair.reQaCandidateResultId === null && repair.outputSha256 === null, "repair.pre-derived-output");
    const operation = required(repairOperation, "repair.operation-link");
    ensure(operation.resultId === null, "repair.operation-result");
    ensure(repair.status === "queued" ? operation.status === "queued" : repair.status === "running" ? operation.status === "running" : operation.status === "failed", "repair.operation-status");
    if (repair.status === "queued") ensure(repair.startedAt === null && repair.completedAt === null, "repair.queued-tuple");
    if (repair.status === "running") ensure(repair.startedAt !== null && repair.completedAt === null, "repair.running-tuple");
    if (repair.status === "failed") ensure(repair.completedAt !== null, "repair.failed-tuple");
  } else {
    const operation = required(repairOperation, "repair.derived-operation");
    const derivedRecord = required(repairDerived, "repair.derived-record");
    const reQaRecord = required(repairReQa, "repair.re-qa-record");
    const reQaOp = required(reQaOperation, "repair.re-qa-operation");
    ensure(operation.status === "succeeded" && repair.outputSha256 === derivedRecord.outputSha256 && derivedRecord.repairAttemptId === repair.id && derivedRecord.projectId === repair.projectId &&
      derivedRecord.inputVersionId === input.id && derivedRecord.qaRunId === run.id && derivedRecord.sourceCandidateId === source.candidateId &&
      derivedRecord.sourceAssetId === source.sourceAssetId && derivedRecord.sourceByteSize === source.sourceByteSize && derivedRecord.sourceSha256 === source.sourceSha256 &&
      derivedRecord.storageKeyNormalized === "projects/" + repair.projectId + "/s2/repairs/" + repair.id + "/output.png", "repair.derived-fields");
    ensure(reQaRecord.repairAttemptId === repair.id && reQaRecord.derivedCandidateId === derivedRecord.id && reQaRecord.qaRunId === run.id &&
      reQaRecord.inputVersionId === input.id && reQaRecord.candidateId === source.candidateId && reQaRecord.candidateIndex === source.candidateIndex &&
      reQaRecord.sourceAssetId === source.sourceAssetId && reQaRecord.sourceByteSize === source.sourceByteSize && reQaRecord.sourceSha256 === source.sourceSha256, "repair.re-qa-fields");
    ensure(repair.completedAt !== null, "repair.derived-completed");
    if (repair.status === "derived_ready") ensure(reQaRecord.status === "queued" && reQaOp.status === "queued", "repair.derived-ready-tuple");
    if (repair.status === "re_qa_running") ensure(reQaRecord.status === "running" && reQaOp.status === "running", "repair.re-qa-running-tuple");
    const terminalRepairStatuses: Record<string, string> = { pass: "re_qa_pass", warning: "re_qa_warning", material_fail: "re_qa_material_fail", re_qa_unavailable: "re_qa_unavailable" };
    if (Object.prototype.hasOwnProperty.call(terminalRepairStatuses, reQaRecord.status)) {
      ensure(repair.status === terminalRepairStatuses[reQaRecord.status], "repair.re-qa-terminal-status");
      ensure(reQaRecord.status === "re_qa_unavailable" ? reQaOp.status === "failed" : reQaOp.status === "succeeded", "repair.re-qa-operation-status");
    }
  }
}

function validateDerivedRecord(record: S2DerivedCandidate, repair: S2RepairAttempt, input: S2InputVersion, run: S2QaRun): void {
  const source = validateRepairSource(repair, input);
  ensure(record.projectId === repair.projectId && record.sourceGenerationSetId === input.sourceGenerationSetId && record.inputVersionId === input.id &&
    record.qaRunId === run.id && record.sourceCandidateId === source.candidateId && record.repairAttemptId === repair.id &&
    record.sourceAssetId === source.sourceAssetId && record.sourceByteSize === source.sourceByteSize && record.sourceSha256 === source.sourceSha256, "derived.lineage");
}

function validateReQaRecord(record: S2ReQaResult, repair: S2RepairAttempt, derived: S2DerivedCandidate, run: S2QaRun, input: S2InputVersion, resultIds: Set<string>): void {
  ensure(!resultIds.has(record.id), "re-qa.duplicate-id");
  resultIds.add(record.id);
  const source = validateRepairSource(repair, input);
  ensure(record.qaRunId === run.id && record.inputVersionId === input.id && record.candidateId === source.candidateId && record.candidateIndex === source.candidateIndex &&
    record.attempt === 1 && record.sourceAssetId === source.sourceAssetId && record.sourceByteSize === source.sourceByteSize && record.sourceSha256 === source.sourceSha256 &&
    record.phase === "re_qa" && record.derivedCandidateId === derived.id && record.repairAttemptId === repair.id, "re-qa.lineage");
  validateObservationSet(record, input);
}

function reQaIdentity(value: S2ReQaResult): AnyRecord {
  return { id: value.id, qaRunId: value.qaRunId, inputVersionId: value.inputVersionId, candidateId: value.candidateId,
    candidateIndex: value.candidateIndex, attempt: value.attempt, sourceAssetId: value.sourceAssetId,
    sourceByteSize: value.sourceByteSize, sourceSha256: value.sourceSha256, repairAttemptId: value.repairAttemptId,
    phase: value.phase, derivedCandidateId: value.derivedCandidateId };
}

function operationIdentity(value: S2Operation): AnyRecord {
  return { id: value.id, projectId: value.projectId, phase: value.phase, attempt: value.attempt, qaRunId: value.qaRunId,
    candidateId: value.candidateId, repairAttemptId: value.repairAttemptId, inputHash: value.inputHash,
    referenceId: value.referenceId, resultId: value.resultId };
}

function validateOperationTarget(operation: S2Operation, result: S2QaCandidateResult | S2ReQaResult | null, repair: S2RepairAttempt | null): void {
  if (operation.phase === "qa") {
    ensure(result !== null, "operation.qa-result");
    if (operation.status === "queued") ensure(result.status === "queued", "operation.qa-queued");
    if (operation.status === "running") ensure(result.status === "running", "operation.qa-running");
    if (operation.status === "succeeded") ensure((TERMINAL_CANDIDATE_STATUSES as readonly string[]).includes(result.status), "operation.qa-succeeded");
    if (operation.status === "failed") ensure(result.status === "qa_unavailable_retryable" || result.status === "qa_unavailable_terminal", "operation.qa-failed");
  } else if (operation.phase === "repair") {
    ensure(repair !== null, "operation.repair-record");
    if (operation.status === "queued") ensure(repair.status === "queued", "operation.repair-queued");
    if (operation.status === "running") ensure(repair.status === "running", "operation.repair-running");
    if (operation.status === "succeeded") ensure(repair.status === "derived_ready" || repair.status === "re_qa_running" || repair.status.startsWith("re_qa_"), "operation.repair-succeeded");
    if (operation.status === "failed") ensure(repair.status === "failed", "operation.repair-failed");
  } else {
    ensure(result !== null && repair !== null, "operation.re-qa-records");
    if (operation.status === "queued") ensure(result.status === "queued" && repair.status === "derived_ready", "operation.re-qa-queued");
    if (operation.status === "running") ensure(result.status === "running" && repair.status === "re_qa_running", "operation.re-qa-running");
    if (operation.status === "succeeded") ensure(result.status === "pass" || result.status === "warning" || result.status === "material_fail", "operation.re-qa-succeeded");
    if (operation.status === "failed") ensure(result.status === "re_qa_unavailable" && repair.status === "re_qa_unavailable", "operation.re-qa-failed");
  }
}

function expectedTransitionStart(operation: S2Operation): string {
  if (operation.phase === "qa") return operation.attempt === 1 ? "none" : "qa_unavailable_retryable";
  return operation.phase === "repair" ? "eligible" : "derived_ready";
}

function expectedTransitionEnd(operation: S2Operation, result: S2QaCandidateResult | S2ReQaResult | null, repair: S2RepairAttempt | null): string {
  if (operation.phase === "qa") {
    ensure(result !== null, "transition.qa-result");
    return result.status;
  }
  if (operation.phase === "repair") {
    ensure(repair !== null, "transition.repair-record");
    return operation.status === "succeeded" ? "derived_ready" : repair.status;
  }
  ensure(result !== null, "transition.re-qa-result");
  if (operation.status === "succeeded") {
    if (result.status === "pass") return "re_qa_pass";
    if (result.status === "warning") return "re_qa_warning";
    if (result.status === "material_fail") return "re_qa_material_fail";
  }
  return operation.status === "failed" ? "re_qa_unavailable" : result.status;
}

function validateOperationTransitionHistory(
  operation: S2Operation,
  result: S2QaCandidateResult | S2ReQaResult | null,
  repair: S2RepairAttempt | null,
  transitions: readonly S2TransitionRecord[],
): void {
  const history = transitions.filter((transition) => transition.operationId === operation.id);
  ensure(history.length > 0, "transition.history-required");
  ensure(history[0].from === expectedTransitionStart(operation) && history[0].to === "queued", "transition.initial-state");

  const seenPairs = new Set<string>();
  for (let index = 0; index < history.length; index += 1) {
    const transition = history[index];
    const pair = transition.from + ":" + transition.to;
    if (index > 0) {
      const previous = history[index - 1];
      ensure(previous.to === transition.from, "transition.history-gap");
      ensure(Date.parse(previous.at) <= Date.parse(transition.at), "transition.timestamp-order");
    }
    ensure(!seenPairs.has(pair) || pair === "queued:running" || pair === "running:queued", "transition.impossible-duplicate");
    seenPairs.add(pair);
    if (pair === "running:queued") {
      ensure(index > 0 && history[index - 1].from === "queued" && history[index - 1].to === "running", "transition.recovery-topology");
    }
  }

  const final = history[history.length - 1].to;
  const expected = expectedTransitionEnd(operation, result, repair);
  ensure(final === expected, "transition.final-state");
  if (operation.status === "running") {
    ensure(final === "running" && history[history.length - 1].from === "queued", "transition.running-state");
  } else if (operation.status === "succeeded" || operation.status === "failed") {
    ensure(history.length >= 3 && history[history.length - 1].from === "running", "transition.terminal-state");
  }
}

function expectedAssetKeys(publication: S2UploadPublication): { staging: S2PublicationObject[]; final: S2PublicationObject[] } {
  const asset = publication.intendedAsset;
  return {
    staging: [
      { key: "projects/" + publication.projectId + "/s2/staging/reference-assets/" + asset.id + "/original", sha256: asset.originalSha256, byteSize: asset.originalBytes },
      { key: "projects/" + publication.projectId + "/s2/staging/reference-assets/" + asset.id + "/normalized.png", sha256: asset.normalizedSha256, byteSize: asset.normalizedBytes },
    ],
    final: [
      { key: "projects/" + publication.projectId + "/s2/references/" + asset.id + "/original", sha256: asset.originalSha256, byteSize: asset.originalBytes },
      { key: "projects/" + publication.projectId + "/s2/references/" + asset.id + "/normalized.png", sha256: asset.normalizedSha256, byteSize: asset.normalizedBytes },
    ],
  };
}

function assetIdentity(value: StoreState["s2Assets"][number]): AnyRecord {
  const { status: _status, deletedAt: _deletedAt, ...identity } = value;
  return identity;
}

function validateUploadPublication(publication: S2UploadPublication, state: StoreState, projects: Map<string, StoreState["projects"][number]>, idempotency: Map<string, StoreState["idempotency"][number]>): void {
  ensure(projects.has(publication.projectId) && publication.assetId === publication.intendedAsset.id && publication.intendedAsset.projectId === publication.projectId, "publication.upload-owner");
  ensure(publication.inputHash === operationInputHash("s2_asset_upload", publication.projectId, {
    kind: publication.intendedAsset.kind, originalSha256: publication.intendedAsset.originalSha256, originalBytes: publication.intendedAsset.originalBytes,
  }), "publication.upload-hash");
  const expected = expectedAssetKeys(publication);
  ensure(equalJson(publication.stagingObjects, expected.staging) && equalJson(publication.finalObjects, expected.final), "publication.upload-objects");
  const actual = state.s2Assets.find((item) => item.id === publication.assetId);
  if (publication.state === "committed") {
    ensure(actual !== undefined && equalJson(assetIdentity(actual), assetIdentity(publication.intendedAsset)), "publication.upload-committed-asset");
    const record = idempotency.get(publication.idempotencyKey);
    ensure(record !== undefined && record.operation === "s2_asset_upload" && record.projectId === publication.projectId, "publication.upload-idempotency");
  } else {
    ensure(actual === undefined, "publication.upload-premature-asset");
  }
  if (publication.state === "aborted") ensure(actual === undefined, "publication.upload-aborted-asset");
}

function validateRepairPublication(publication: S2RepairPublication, state: StoreState, projects: Map<string, StoreState["projects"][number]>, inputs: Map<string, S2InputVersion>, runs: Map<string, S2QaRun>, repairs: Map<string, S2RepairAttempt>, operations: Map<string, S2Operation>, derived: Map<string, S2DerivedCandidate>, reQa: Map<string, S2ReQaResult>): void {
  const input = inputs.get(publication.inputVersionId);
  const run = runs.get(publication.qaRunId);
  const repair = repairs.get(publication.repairAttemptId);
  const operation = operations.get(publication.operationId);
  ensure(projects.has(publication.projectId) && input !== undefined && run !== undefined && repair !== undefined && operation !== undefined, "publication.repair-owner");
  ensure(input.projectId === publication.projectId && run.projectId === publication.projectId && repair.projectId === publication.projectId && operation.projectId === publication.projectId &&
    input.qaRunId === run.id && repair.qaRunId === run.id && repair.inputVersionId === input.id && operation.qaRunId === run.id && operation.phase === "repair" &&
    operation.repairAttemptId === repair.id && operation.candidateId === publication.candidateId && repair.candidateId === publication.candidateId && publication.inputHash === operation.inputHash, "publication.repair-lineage");
  const source = validateRepairSource(repair, input);
  ensure(source.candidateId === publication.candidateId, "publication.repair-candidate");
  const intended = publication.intendedDerived;
  ensure(intended.projectId === publication.projectId && intended.sourceGenerationSetId === input.sourceGenerationSetId && intended.inputVersionId === input.id &&
    intended.qaRunId === run.id && intended.sourceCandidateId === source.candidateId && intended.repairAttemptId === repair.id && intended.sourceAssetId === source.sourceAssetId &&
    intended.sourceByteSize === source.sourceByteSize && intended.sourceSha256 === source.sourceSha256, "publication.intended-derived");
  const intendedReQa = publication.intendedReQa;
  ensure(intendedReQa.qaRunId === run.id && intendedReQa.inputVersionId === input.id && intendedReQa.candidateId === source.candidateId && intendedReQa.candidateIndex === source.candidateIndex &&
    intendedReQa.sourceAssetId === source.sourceAssetId && intendedReQa.sourceByteSize === source.sourceByteSize && intendedReQa.sourceSha256 === source.sourceSha256 &&
    intendedReQa.repairAttemptId === repair.id && intendedReQa.derivedCandidateId === intended.id, "publication.intended-re-qa");
  const intendedOperation = publication.intendedReQaOperation;
  ensure(intendedOperation.projectId === publication.projectId && intendedOperation.phase === "re_qa" && intendedOperation.attempt === 1 &&
    intendedOperation.qaRunId === run.id && intendedOperation.candidateId === source.candidateId && intendedOperation.repairAttemptId === repair.id &&
    intendedOperation.inputHash === input.inputHash && intendedOperation.resultId === intendedReQa.id, "publication.intended-operation");
  ensure(equalJson(publication.stagingObjects, [{ key: "projects/" + publication.projectId + "/s2/repairs/" + repair.id + "/staged/provider-output.png", sha256: intended.outputSha256, byteSize: intended.normalizedBytes }]) &&
    equalJson(publication.finalObjects, [{ key: "projects/" + publication.projectId + "/s2/repairs/" + repair.id + "/output.png", sha256: intended.outputSha256, byteSize: intended.normalizedBytes }]), "publication.repair-objects");
  const actualDerived = derived.get(intended.id);
  const actualReQa = reQa.get(intendedReQa.id);
  const actualReQaOperation = operations.get(intendedOperation.id);
  if (publication.state === "committed") {
    ensure(actualDerived !== undefined && actualReQa !== undefined && actualReQaOperation !== undefined && equalJson(actualDerived, intended) &&
      equalJson(reQaIdentity(actualReQa), reQaIdentity(intendedReQa)) && equalJson(operationIdentity(actualReQaOperation), operationIdentity(intendedOperation)), "publication.repair-committed-lineage");
  } else {
    ensure(actualDerived === undefined && actualReQa === undefined && actualReQaOperation === undefined, "publication.repair-premature-lineage");
    if (publication.state === "aborted") ensure(operation.status === "failed" && repair.status === "failed", "publication.repair-aborted-tuple");
    else ensure(operation.status === "running" && repair.status === "running", "publication.repair-pending-tuple");
  }
  if (publication.state === "committed") ensure(repair.outputSha256 === intended.outputSha256 && repair.derivedCandidateId === intended.id && repair.reQaCandidateResultId === intendedReQa.id, "publication.repair-links");
}

function validateS2Idempotency(state: StoreState, projects: Map<string, StoreState["projects"][number]>, drafts: Map<string, S2ReferenceDraft>, inputs: Map<string, S2InputVersion>, runs: Map<string, S2QaRun>, repairs: Map<string, S2RepairAttempt>, operations: Map<string, S2Operation>): Map<string, StoreState["idempotency"][number]> {
  const records = uniqueBy(state.idempotency, (item) => item.key, "idempotency");
  for (const record of records.values()) {
    ensure(uuidV4Pattern.test(record.key) && typeof record.operation === "string" && typeof record.projectId === "string" && SHA256.test(record.inputHash), "idempotency.record-shape");
    if (!record.operation.startsWith("s2_")) continue;
    ensure(["s2_asset_upload", "s2_draft_update", "s2_bind", "s2_qa_retry", "s2_repair"].includes(record.operation), "idempotency.unknown-s2-operation");
    ensure(projects.has(record.projectId), "idempotency.owner");
    ensure(isRecord(record.result), "idempotency.result-object");
    const result = record.result as AnyRecord;
    if (record.operation === "s2_asset_upload") {
      ensure(exactKeys(result, ["assetId"]) && typeof result.assetId === "string", "idempotency.upload-result");
      const asset = state.s2Assets.find((item) => item.id === result.assetId);
      const publication = state.s2Publications.find((item) => item.kind === "asset_upload" && item.idempotencyKey === record.key);
      const intended = asset ?? (publication?.kind === "asset_upload" ? publication.intendedAsset : undefined);
      ensure(intended !== undefined && intended.projectId === record.projectId && record.inputHash === operationInputHash("s2_asset_upload", record.projectId, { kind: intended.kind, originalSha256: intended.originalSha256, originalBytes: intended.originalBytes }), "idempotency.upload-lineage");
    } else if (record.operation === "s2_draft_update") {
      ensure(exactKeys(result, ["draftId"]) && typeof result.draftId === "string", "idempotency.draft-result");
      ensure(drafts.get(result.draftId)?.projectId === record.projectId, "idempotency.draft-lineage");
    } else if (record.operation === "s2_bind") {
      ensure(exactKeys(result, ["inputVersionId", "qaRunId", "operationIds"]) && typeof result.inputVersionId === "string" && typeof result.qaRunId === "string" && Array.isArray(result.operationIds), "idempotency.bind-result");
      const input = inputs.get(result.inputVersionId); const run = runs.get(result.qaRunId);
      ensure(input !== undefined && run !== undefined && input.projectId === record.projectId && run.projectId === record.projectId && input.qaRunId === run.id &&
        result.operationIds.length === 4 && result.operationIds.every((id) => typeof id === "string" && operations.get(id)?.qaRunId === run.id), "idempotency.bind-lineage");
      ensure(record.inputHash === operationInputHash("s2_bind", record.projectId, { sourceGenerationSetId: input.sourceGenerationSetId, expectedDraftRevision: input.draftRevision, bindingHash: input.bindingHash }), "idempotency.bind-hash");
    } else if (record.operation === "s2_qa_retry") {
      ensure(exactKeys(result, ["qaRunId", "candidateId", "operationId", "resultId"]) && typeof result.qaRunId === "string" && typeof result.candidateId === "string" && typeof result.operationId === "string" && typeof result.resultId === "string", "idempotency.retry-result");
      const run = runs.get(result.qaRunId); const operation = operations.get(result.operationId);
      ensure(run !== undefined && operation !== undefined && run.projectId === record.projectId && operation.phase === "qa" && operation.attempt === 2 && operation.qaRunId === run.id && operation.candidateId === result.candidateId && operation.resultId === result.resultId, "idempotency.retry-lineage");
      ensure(record.inputHash === operationInputHash("s2_qa_retry", record.projectId, { qaRunId: result.qaRunId, candidateId: result.candidateId, expectedAttempt: 1 }), "idempotency.retry-hash");
    } else {
      ensure(exactKeys(result, ["repairAttemptId", "operationId"]) && typeof result.repairAttemptId === "string" && typeof result.operationId === "string", "idempotency.repair-result");
      const repair = repairs.get(result.repairAttemptId); const operation = operations.get(result.operationId);
      ensure(repair !== undefined && operation !== undefined && repair.projectId === record.projectId && operation.phase === "repair" && operation.repairAttemptId === repair.id && operation.qaRunId === repair.qaRunId && operation.candidateId === repair.candidateId, "idempotency.repair-lineage");
      ensure(record.inputHash === operationInputHash("s2_repair", record.projectId, { qaRunId: repair.qaRunId, candidateId: repair.candidateId, expectedInputVersionId: repair.inputVersionId, eligibleFindingIds: repair.eligibleFindingIds }), "idempotency.repair-hash");
    }
  }
  return records;
}

export function validateS2Graph(state: StoreState): void {
  const projects = uniqueBy(state.projects, (item) => item.projectId, "project");
  const briefVersions = uniqueBy(state.briefVersions, (item) => item.briefVersionId, "brief-version");
  const generationSets = uniqueBy(state.generationSets, (item) => item.generationSetId, "generation-set");
  const assets = uniqueBy(state.s2Assets, (item) => item.id, "s2-asset");
  const drafts = uniqueBy(state.s2Drafts, (item) => item.id, "s2-draft");
  const inputs = uniqueBy(state.s2Inputs, (item) => item.id, "s2-input");
  const runs = uniqueBy(state.s2QaRuns, (item) => item.id, "qa-run");
  const repairs = uniqueBy(state.s2Repairs, (item) => item.id, "repair");
  const derived = uniqueBy(state.s2DerivedCandidates, (item) => item.id, "derived");
  const reQa = uniqueBy(state.s2ReQaResults, (item) => item.id, "re-qa");
  const operations = uniqueBy(state.s2Operations, (item) => item.id, "operation");
  const publicationIds = new Set<string>();

  for (const asset of assets.values()) {
    ensure(projects.has(asset.projectId), "asset.project");
    ensure(asset.status === "ready" ? asset.deletedAt === null : asset.deletedAt !== null, "asset.status-deletedAt");
    ensure(asset.storageKeyOriginal === "projects/" + asset.projectId + "/s2/references/" + asset.id + "/original" &&
      asset.storageKeyNormalized === "projects/" + asset.projectId + "/s2/references/" + asset.id + "/normalized.png", "asset.storage-identity");
  }
  const draftByProject = new Map<string, S2ReferenceDraft>();
  for (const draft of drafts.values()) {
    ensure(projects.has(draft.projectId), "draft.project");
    ensure(!draftByProject.has(draft.projectId), "draft.one-per-project");
    draftByProject.set(draft.projectId, draft);
    ensure(draft.referenceAssetIds.length <= MAX_REFERENCES && draft.logoAssetIds.length <= MAX_LOGOS &&
      draft.referenceAssetIds.length + draft.logoAssetIds.length <= MAX_TOTAL_ASSETS, "draft.limits");
    ensure(new Set(draft.referenceAssetIds).size === draft.referenceAssetIds.length && new Set(draft.logoAssetIds).size === draft.logoAssetIds.length &&
      new Set([...draft.referenceAssetIds, ...draft.logoAssetIds]).size === draft.referenceAssetIds.length + draft.logoAssetIds.length, "draft.unique-slots");
    for (const [ids, kind] of [[draft.referenceAssetIds, "reference"], [draft.logoAssetIds, "logo"]] as const) for (const id of ids) {
      const asset = assets.get(id);
      ensure(asset !== undefined && asset.projectId === draft.projectId && asset.kind === kind && asset.status === "ready", "draft.asset-lineage");
    }
    if (draft.status === "editable") ensure(draft.frozenAt === null && draft.frozenByQaRunId === null, "draft.editable-frozen-fields");
  }
  ensure(inputs.size <= state.projects.filter((project) => draftByProject.has(project.projectId)).length, "input.project-cardinality");
  const inputByProject = new Map<string, S2InputVersion>();
  for (const input of inputs.values()) {
    ensure(!inputByProject.has(input.projectId), "input.one-per-project");
    inputByProject.set(input.projectId, input);
    validateSourceLineage(state, input, projects, generationSets, briefVersions);
  }
  for (const draft of drafts.values()) {
    const input = inputByProject.get(draft.projectId);
    if (draft.status === "frozen") {
      ensure(draft.frozenAt !== null && draft.frozenByQaRunId !== null, "draft.frozen-fields");
      const run = draft.frozenByQaRunId ? runs.get(draft.frozenByQaRunId) : undefined;
      ensure(run !== undefined && run.projectId === draft.projectId, "draft.frozen-run");
      ensure(input !== undefined && input.qaRunId === run.id, "draft.frozen-input");
    } else ensure(input === undefined, "draft.editable-with-bound-input");
  }
  const idempotency = validateS2Idempotency(state, projects, drafts, inputs, runs, repairs, operations);
  const resultIds = new Set<string>();
  const runByInput = new Set<string>();
  for (const run of runs.values()) {
    const input = inputs.get(run.inputVersionId);
    ensure(input !== undefined && run.projectId === input.projectId && run.sourceGenerationSetId === input.sourceGenerationSetId && input.qaRunId === run.id, "qa-run.input-lineage");
    ensure(!runByInput.has(input.id), "qa-run.one-per-input");
    runByInput.add(input.id);
    for (const result of run.candidateResults) {
      validateRunResultLineage(result, run, input, resultIds);
    }
    validateRunRetryTopology(run, input, operations, idempotency);
    const latest = SOURCE_INDEXES.map((index) => {
      const values = run.candidateResults.filter((item) => item.candidateIndex === index);
      ensure(values.length > 0, "qa-run.candidate-cardinality");
      return values.sort((left, right) => right.attempt - left.attempt)[0];
    });
    for (const result of run.candidateResults) {
      if (result.repairAttemptId !== null) {
        const repair = repairs.get(result.repairAttemptId);
        const canonical = latest.find((item) => item.candidateId === result.candidateId);
        ensure(canonical?.id === result.id && repair !== undefined && repair.qaRunId === run.id && repair.candidateId === result.candidateId, "qa-result.repair-lineage");
      }
    }
    validateRunLifecycle(run, latest);
  }
  for (const run of runs.values()) for (const result of run.candidateResults) {
    const matches = Array.from(operations.values()).filter((item) => item.phase === "qa" && item.qaRunId === run.id && item.candidateId === result.candidateId && item.attempt === result.attempt && item.resultId === result.id);
    ensure(matches.length === 1, "qa-result.operation-cardinality");
  }
  for (const input of inputs.values()) ensure(runs.has(input.qaRunId), "input.qa-run");
  for (const draft of drafts.values()) {
    if (draft.status === "frozen") {
      const run = runs.get(draft.frozenByQaRunId!);
      ensure(run !== undefined && run.projectId === draft.projectId, "draft.frozen-run-owner");
    }
  }
  for (const record of reQa.values()) {
    ensure(repairs.has(record.repairAttemptId) && derived.has(record.derivedCandidateId), "re-qa.parent-records");
  }
  for (const repair of repairs.values()) {
    const input = inputs.get(repair.inputVersionId); const run = runs.get(repair.qaRunId);
    ensure(input !== undefined && run !== undefined && input.qaRunId === run.id, "repair.run-input");
    ensure(repair.projectId === input.projectId && run.projectId === input.projectId, "repair.project-lineage");
  }
  const repairByCandidate = new Set<string>();
  for (const repair of repairs.values()) {
    const repairKey = repair.qaRunId + ":" + repair.candidateId;
    ensure(!repairByCandidate.has(repairKey), "repair.one-per-candidate");
    repairByCandidate.add(repairKey);
    validateRepairState(repair, runs.get(repair.qaRunId)!, inputs.get(repair.inputVersionId)!, state, operations, derived, reQa);
  }
  for (const record of derived.values()) {
    const repair = repairs.get(record.repairAttemptId); const input = inputs.get(record.inputVersionId); const run = runs.get(record.qaRunId);
    ensure(repair !== undefined && input !== undefined && run !== undefined, "derived.parents");
    ensure(repair.derivedCandidateId === record.id, "derived.repair-link");
    validateDerivedRecord(record, repair, input, run);
  }
  for (const record of reQa.values()) {
    const repair = repairs.get(record.repairAttemptId); const derivedRecord = derived.get(record.derivedCandidateId); const input = inputs.get(record.inputVersionId); const run = runs.get(record.qaRunId);
    ensure(repair !== undefined && derivedRecord !== undefined && input !== undefined && run !== undefined && repair.derivedCandidateId === derivedRecord.id && repair.reQaCandidateResultId === record.id, "re-qa.parents");
    validateReQaRecord(record, repair, derivedRecord, run, input, resultIds);
  }
  for (const record of reQa.values()) {
    const matches = Array.from(operations.values()).filter((item) => item.phase === "re_qa" && item.resultId === record.id && item.repairAttemptId === record.repairAttemptId);
    ensure(matches.length === 1, "re-qa.operation-cardinality");
  }
  const claimTokens = new Set<string>();
  const operationTopology = new Set<string>();
  for (const operation of operations.values()) {
    const input = inputs.get(runs.get(operation.qaRunId)?.inputVersionId ?? "");
    const run = runs.get(operation.qaRunId);
    ensure(run !== undefined && input !== undefined && operation.projectId === run.projectId && input.projectId === operation.projectId, "operation.owner-lineage");
    let result: S2QaCandidateResult | S2ReQaResult | null = null;
    let repair: S2RepairAttempt | null = null;
    if (operation.phase === "qa") {
      ensure(operation.repairAttemptId === null && operation.inputHash === input.inputHash, "operation.qa-fields");
      result = run.candidateResults.find((item) => item.id === operation.resultId) ?? null;
      ensure(result !== null && result.candidateId === operation.candidateId && result.attempt === operation.attempt, "operation.qa-result-lineage");
    } else {
      ensure(operation.attempt === 1 && operation.repairAttemptId !== null, "operation.repair-fields");
      repair = repairs.get(operation.repairAttemptId) ?? null;
      ensure(repair !== null && repair.projectId === operation.projectId && repair.qaRunId === operation.qaRunId && repair.candidateId === operation.candidateId, "operation.repair-lineage");
      if (operation.phase === "repair") {
        ensure(operation.resultId === null && operation.inputHash === operationInputHash("s2_repair", operation.projectId, {
          qaRunId: repair.qaRunId, candidateId: repair.candidateId, expectedInputVersionId: repair.inputVersionId, eligibleFindingIds: repair.eligibleFindingIds,
        }), "operation.repair-hash");
      } else {
        ensure(operation.resultId !== null && operation.inputHash === input.inputHash, "operation.re-qa-hash");
        result = reQa.get(operation.resultId) ?? null;
        ensure(result !== null && result.candidateId === operation.candidateId && result.repairAttemptId === repair.id, "operation.re-qa-result-lineage");
      }
    }
    const topologyKey = operation.phase + ":" + operation.qaRunId + ":" + operation.candidateId + ":" + operation.attempt;
    ensure(!operationTopology.has(topologyKey), "operation.duplicate-topology");
    operationTopology.add(topologyKey);
    if (operation.status === "queued" || operation.status === "running") ensure(operation.failureCode === null, "operation.nonterminal-error");
    if (operation.status === "succeeded") ensure(operation.failureCode === null, "operation.success-error");
    if (operation.status === "failed") ensure(operation.failureCode !== null, "operation.failed-error");
    if (operation.claimToken !== null) {
      ensure(operation.status === "running" && !claimTokens.has(operation.claimToken), "operation.claim-token");
      claimTokens.add(operation.claimToken);
    }
    validateOperationTarget(operation, result, repair);
  }
  for (const publication of state.s2Publications) {
    ensure(!publicationIds.has(publication.id), "publication.duplicate-id");
    publicationIds.add(publication.id);
    if (publication.kind === "asset_upload") validateUploadPublication(publication, state, projects, idempotency);
    else validateRepairPublication(publication, state, projects, inputs, runs, repairs, operations, derived, reQa);
  }
  const transitionIds = new Set<string>();
  for (const transition of state.s2Transitions) {
    ensure(!transitionIds.has(transition.id), "transition.duplicate-id");
    transitionIds.add(transition.id);
    const operation = operations.get(transition.operationId);
    ensure(operation !== undefined && transition.projectId === operation.projectId && transition.phase === operation.phase && transition.attempt === operation.attempt, "transition.operation-lineage");
    ensure(transition.referenceId === operation.referenceId, "transition.reference-lineage");
    const pair = transition.from + ":" + transition.to;
    const allowed = transition.phase === "qa"
      ? ["none:queued", "queued:running", "running:queued", "running:pass", "running:warning", "running:material_fail", "running:qa_unavailable_retryable", "running:qa_unavailable_terminal", "qa_unavailable_retryable:queued", "qa_unavailable_retryable:running"]
      : transition.phase === "repair"
        ? ["eligible:queued", "queued:running", "running:queued", "running:failed", "running:derived_ready"]
        : ["derived_ready:queued", "queued:running", "running:queued", "running:re_qa_pass", "running:re_qa_warning", "running:re_qa_material_fail", "running:re_qa_unavailable"];
    ensure(allowed.includes(pair), "transition.status-pair");
  }
  for (const operation of operations.values()) {
    const run = runs.get(operation.qaRunId);
    const result = operation.phase === "qa"
      ? run?.candidateResults.find((item) => item.id === operation.resultId) ?? null
      : operation.phase === "re_qa" ? reQa.get(operation.resultId ?? "") ?? null : null;
    const repair = operation.phase === "qa" ? null : repairs.get(operation.repairAttemptId ?? "") ?? null;
    validateOperationTransitionHistory(operation, result, repair, state.s2Transitions);
  }
  for (const draft of drafts.values()) {
    if (draft.status === "frozen") {
      const run = runs.get(draft.frozenByQaRunId!);
      ensure(run !== undefined && run.projectId === draft.projectId, "draft.frozen-final-lineage");
    }
  }
}
