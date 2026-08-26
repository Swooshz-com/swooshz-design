export type UUID = string;
export type Timestamp = string;
export type Sha256 = string;

export type ProjectStatus =
  | "draft"
  | "geometry_ready"
  | "extracting"
  | "brief_extraction_failed"
  | "brief_review"
  | "brief_confirmed"
  | "generating"
  | "generation_failed"
  | "concepts_ready";

export type OpenSide = "north" | "east" | "south" | "west";

export type BoothGeometry = {
  widthMm: number;
  depthMm: number;
  openSides: OpenSide[];
  maxHeightMm: number | null;
};

export type Project = {
  projectId: UUID;
  name: string;
  status: ProjectStatus;
  boothGeometry: BoothGeometry | null;
  briefAssetId: UUID | null;
  briefDraftId: UUID | null;
  confirmedBriefVersionId: UUID | null;
  activeGenerationSetId: UUID | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type BriefAsset = {
  assetId: UUID;
  projectId: UUID;
  kind: "brief";
  originalFileName: string;
  mimeType: "application/pdf";
  byteSize: number;
  pageCount: number;
  storageKey: string;
  sha256: Sha256;
  status: "stored";
  createdAt: Timestamp;
};

export type ProjectFacts = {
  clientName: string | null;
  eventName: string | null;
  venueName: string | null;
  eventLocation: string | null;
  eventStartDate: string | null;
  eventEndDate: string | null;
  notes: string | null;
};

export type BrandStyle = {
  brandName: string | null;
  brandValues: string[];
  visualDirection: string | null;
  preferredColors: string[];
  materials: string[];
  logoInstructions: string | null;
};

export type FunctionalRequirement = {
  name: string;
  count: number | null;
  countIsExact: boolean;
  mandatory: boolean;
  details: string | null;
};

export type Budget = {
  amount: number | null;
  currency: string | null;
  basis: "total" | "per_sqm" | "unknown" | null;
  notes: string | null;
};

export type UnknownItem = {
  id: string;
  field: string;
  question: string;
  critical: boolean;
  resolution: string | null;
  acceptedByUser: boolean;
};

export type AssumptionItem = {
  id: string;
  field: string;
  value: string;
  source: "model" | "user";
  requiresConfirmation: boolean;
  acceptedByUser: boolean;
};

export type ExtractedGeometryMentions = {
  widthText: string | null;
  depthText: string | null;
  openSidesText: string | null;
  maxHeightText: string | null;
};

export type StructuredBriefData = {
  projectFacts: ProjectFacts;
  brandStyle: BrandStyle;
  functionalRequirements: FunctionalRequirement[];
  mandatoryRequirements: string[];
  prohibitedRequirements: string[];
  budget: Budget;
  unknowns: UnknownItem[];
  assumptions: AssumptionItem[];
  freeTextRequirements: string[];
  extractedGeometryMentions: ExtractedGeometryMentions;
};

export type ProviderMetadata = {
  provider: "openai";
  api: "responses" | "images";
  model: "gpt-5.4-mini" | "gpt-image-2";
  modelSnapshot:
    | "gpt-5.4-mini-2026-03-17"
    | "gpt-image-2-2026-04-21";
  providerRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  receivedAt: Timestamp;
};

export type StructuredBriefDraft = {
  briefDraftId: UUID;
  projectId: UUID;
  sourceAssetId: UUID;
  extractionRequestId: UUID;
  schemaVersion: "brief-v1";
  revision: number;
  status: "extracted" | "edited";
  data: StructuredBriefData;
  providerMetadata: ProviderMetadata;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type StructuredBriefVersion = {
  briefVersionId: UUID;
  projectId: UUID;
  sourceDraftId: UUID;
  sourceAssetId: UUID;
  versionNumber: 1;
  schemaVersion: "brief-v1";
  status: "confirmed";
  geometrySnapshot: BoothGeometry;
  data: StructuredBriefData;
  contentHash: Sha256;
  confirmationMode: "explicit_user_action";
  confirmedAt: Timestamp;
  extractionProviderMetadata: ProviderMetadata;
};

export type UserConfirmedBrief = {
  briefVersionId: UUID;
  projectId: UUID;
  versionNumber: 1;
  sourceAssetId: UUID;
  schemaVersion: "brief-v1";
  geometrySnapshot: BoothGeometry;
  data: StructuredBriefData;
  contentHash: Sha256;
  confirmedAt: Timestamp;
};

export type CompilerMetadata = {
  compilerVersion: "g2-booth-v1";
  directionKey: CandidateDirection;
  canonicalInputHash: Sha256;
  promptHash: Sha256;
  compiledAt: Timestamp;
};

export type GenerationRequest = {
  generationRequestId: UUID;
  projectId: UUID;
  confirmedBriefVersionId: UUID;
  generationSetId: UUID;
  idempotencyKey: UUID;
  inputHash: Sha256;
  requestedCandidateCount: 4;
  attempt: 1 | 2;
  status: "accepted" | "running" | "succeeded" | "failed";
  requestReferenceId: UUID;
  failureCode: string | null;
  createdAt: Timestamp;
  completedAt: Timestamp | null;
};

export type GenerationSet = {
  generationSetId: UUID;
  projectId: UUID;
  confirmedBriefVersionId: UUID;
  generationRequestId: UUID;
  attempt: 1 | 2;
  retryOfGenerationSetId: UUID | null;
  status: "queued" | "running" | "succeeded" | "failed";
  expectedCandidateCount: 4;
  promptCompilerVersion: "g2-booth-v1";
  promptManifestHash: Sha256;
  provider: "openai";
  imageModelSnapshot: "gpt-image-2-2026-04-21";
  createdAt: Timestamp;
  completedAt: Timestamp | null;
  failureCode: string | null;
};

export type ConceptAsset = {
  assetId: UUID;
  projectId: UUID;
  generationSetId: UUID;
  storageKey: string;
  mimeType: "image/png";
  byteSize: number;
  sha256: Sha256;
  status: "stored";
  createdAt: Timestamp;
};

export type CandidateDirection =
  | "modular-clarity"
  | "brand-theatre"
  | "open-demo"
  | "hospitality-consultation";

export type ConceptCandidate = {
  candidateId: UUID;
  generationSetId: UUID;
  projectId: UUID;
  confirmedBriefVersionId: UUID;
  candidateIndex: 1 | 2 | 3 | 4;
  directionKey: CandidateDirection;
  assetId: UUID;
  compilerMetadata: CompilerMetadata;
  providerMetadata: ProviderMetadata;
  createdAt: Timestamp;
};

export type CompiledPromptRecord = {
  compiledPromptId: UUID;
  generationSetId: UUID;
  candidateIndex: 1 | 2 | 3 | 4;
  directionKey: CandidateDirection;
  compilerMetadata: CompilerMetadata;
  promptText: string;
  createdAt: Timestamp;
};

export type IdempotencyRecord = {
  key: UUID;
  operation: string;
  projectId: UUID;
  inputHash: Sha256;
  result: Record<string, unknown>;
  createdAt: Timestamp;
};

export type StoreState = {
  projects: Project[];
  briefAssets: BriefAsset[];
  drafts: StructuredBriefDraft[];
  briefVersions: StructuredBriefVersion[];
  generationRequests: GenerationRequest[];
  generationSets: GenerationSet[];
  prompts: CompiledPromptRecord[];
  conceptAssets: ConceptAsset[];
  candidates: ConceptCandidate[];
  idempotency: IdempotencyRecord[];
  extractionAttempts: Record<UUID, number>;
  extractionOperations: ExtractionOperation[];
  generationOperations: GenerationOperation[];
  s2Assets: S2AssetRecord[];
  s2Drafts: S2ReferenceDraft[];
  s2Inputs: S2InputVersion[];
  s2QaRuns: S2QaRun[];
  s2Repairs: S2RepairAttempt[];
  s2DerivedCandidates: S2DerivedCandidate[];
  s2ReQaResults: S2ReQaResult[];
  s2Operations: S2Operation[];
  s2Publications: S2Publication[];
  s2Transitions: S2StateTransition[];
};

export type FieldError = {
  field: string;
  code: string;
};

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: FieldError[];
  readonly logContext: Record<string, string | number | null>;

  constructor(
    status: number,
    code: string,
    fieldErrors: FieldError[] = [],
    logContext: Record<string, string | number | null> = {},
  ) {
    super(code);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.logContext = logContext;
  }
}

export type ExtractionOperation = {
  extractionRequestId: UUID;
  projectId: UUID;
  assetId: UUID;
  attempt: 1 | 2;
  referenceId: UUID;
  status: "queued" | "running" | "succeeded" | "failed";
  claimedBy: string | null;
  claimedProcessId: number | null;
  claimToken: UUID | null;
  claimedAt: Timestamp | null;
  createdAt: Timestamp;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  failureCode: string | null;
};

export type GenerationOperation = {
  generationSetId: UUID;
  projectId: UUID;
  attempt: 1 | 2;
  status: "queued" | "running" | "succeeded" | "failed";
  claimedBy: string | null;
  claimedProcessId: number | null;
  claimToken: UUID | null;
  claimedAt: Timestamp | null;
  createdAt: Timestamp;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  failureCode: string | null;
};

export type S2AssetKind = "reference" | "logo";
export type S2AssetStatus = "ready" | "deleted";
export type S2DraftStatus = "editable" | "frozen";
export type S2InputStatus = "bound";
export type S2QaRunStatus = "queued" | "running" | "completed" | "failed";
export type S2CandidateStatus =
  | "queued"
  | "running"
  | "pass"
  | "warning"
  | "material_fail"
  | "qa_unavailable_retryable"
  | "qa_unavailable_terminal";
export type S2RepairStatus =
  | "not_eligible"
  | "eligible"
  | "queued"
  | "running"
  | "failed"
  | "derived_ready"
  | "re_qa_running"
  | "re_qa_pass"
  | "re_qa_warning"
  | "re_qa_material_fail"
  | "re_qa_unavailable";
export type S2Verdict = "PASS" | "WARNING" | "MATERIAL_FAIL" | "QA_UNAVAILABLE";
export type S2RequirementObserved = "present" | "absent" | "uncertain" | "not_verifiable";

export type S2AssetRecord = {
  id: UUID;
  projectId: UUID;
  kind: S2AssetKind;
  status: S2AssetStatus;
  originalSha256: Sha256;
  originalBytes: number;
  normalizedSha256: Sha256;
  normalizedBytes: number;
  detectedMime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  pixelCount: number;
  hasAlpha: boolean;
  storageKeyOriginal: string;
  storageKeyNormalized: string;
  createdAt: Timestamp;
  deletedAt: Timestamp | null;
};

export type S2ReferenceDraft = {
  id: UUID;
  projectId: UUID;
  revision: number;
  status: S2DraftStatus;
  referenceAssetIds: UUID[];
  logoAssetIds: UUID[];
  updatedAt: Timestamp;
  frozenAt: Timestamp | null;
  frozenByQaRunId: UUID | null;
};

export type S2CandidateSource = {
  candidateId: UUID;
  candidateIndex: 1 | 2 | 3 | 4;
  sourceAssetId: UUID;
  sourceStorageKey: string;
  sourceSha256: Sha256;
  sourceByteSize: number;
  sourceWidth: number;
  sourceHeight: number;
  sourcePixelCount: number;
  sourceDecodedRgbaBytes: number;
};

export type S2Requirement = {
  requirementId: string;
  category: "geometry" | "functional" | "mandatory" | "prohibited" | "free_text";
  expected: "present" | "absent" | "exact_count";
  expectedCount: number | null;
  expectedValue: string | number | boolean | null;
  criticality: "material" | "warning";
  source: "confirmed_brief" | "geometry_snapshot";
  text: string;
};

export type S2DesignRuleSnapshot = {
  ruleId: string;
  applicability: "applicable" | "not_applicable";
  materiality: "material" | "warning";
  repairable: boolean;
};

export type S2InputVersion = {
  id: UUID;
  projectId: UUID;
  sourceGenerationSetId: UUID;
  sourceCandidates: S2CandidateSource[];
  confirmedBriefVersionId: UUID;
  confirmedBriefContentHash: Sha256;
  geometrySnapshot: BoothGeometry;
  geometryHash: Sha256;
  canonicalRequirements: S2Requirement[];
  requirementHash: Sha256;
  designRulesVersion: "s2-design-rules-v1";
  designRuleSnapshot: S2DesignRuleSnapshot[];
  decoderProfile: "s2-media-v1";
  qaModel: "gpt-5.4-mini-2026-03-17";
  qaSchema: "s2-qa-v1";
  referenceAssetIds: UUID[];
  logoAssetIds: UUID[];
  draftRevision: number;
  inputHash: Sha256;
  bindingHash: Sha256;
  status: S2InputStatus;
  createdAt: Timestamp;
  boundAt: Timestamp;
  qaRunId: UUID;
};

export type S2RequirementObservation = {
  requirementId: string;
  expected: "present" | "absent" | "exact_count";
  expectedCount: number | null;
  expectedValue: string | number | boolean | null;
  observed: S2RequirementObserved;
  observedCount: number | null;
  confidence: number;
  evidence: string;
};

export type S2DesignObservation = {
  ruleId: string;
  observed: "compliant" | "non_compliant" | "uncertain" | "not_verifiable";
  confidence: number;
  evidence: string;
};

export type S2QaCandidateResult = {
  id: UUID;
  qaRunId: UUID;
  inputVersionId: UUID;
  candidateId: UUID;
  candidateIndex: 1 | 2 | 3 | 4;
  attempt: 1 | 2;
  sourceAssetId: UUID;
  sourceByteSize: number;
  sourceSha256: Sha256;
  status: S2CandidateStatus;
  verdict: S2Verdict;
  requirementObservations: S2RequirementObservation[];
  designObservations: S2DesignObservation[];
  materialFindingIds: string[];
  warningFindingIds: string[];
  uncertainFindingIds: string[];
  providerRequestId: string | null;
  repairAttemptId: UUID | null;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
};

export type S2QaRun = {
  id: UUID;
  projectId: UUID;
  inputVersionId: UUID;
  sourceGenerationSetId: UUID;
  status: S2QaRunStatus;
  candidateResults: S2QaCandidateResult[];
  completedCandidateCount: number;
  passCount: number;
  warningCount: number;
  materialFailCount: number;
  unavailableCount: number;
  createdAt: Timestamp;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
};

export type S2RepairAttempt = {
  id: UUID;
  projectId: UUID;
  qaRunId: UUID;
  inputVersionId: UUID;
  candidateId: UUID;
  attempt: 1;
  status: S2RepairStatus;
  eligibleFindingIds: string[];
  sourceAssetId: UUID;
  sourceByteSize: number;
  sourceSha256: Sha256;
  repairInputHash: Sha256;
  repairPromptHash: Sha256;
  outputSha256: Sha256 | null;
  derivedCandidateId: UUID | null;
  reQaCandidateResultId: UUID | null;
  providerRequestId: string | null;
  createdAt: Timestamp;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
};

export type S2DerivedCandidate = {
  id: UUID;
  projectId: UUID;
  sourceGenerationSetId: UUID;
  inputVersionId: UUID;
  qaRunId: UUID;
  sourceCandidateId: UUID;
  repairAttemptId: UUID;
  sourceAssetId: UUID;
  sourceByteSize: number;
  sourceSha256: Sha256;
  outputSha256: Sha256;
  normalizedBytes: number;
  width: number;
  height: number;
  storageKeyNormalized: string;
  createdAt: Timestamp;
};

export type S2ReQaResult = Omit<S2QaCandidateResult, "status"> & {
  status: S2CandidateStatus | "re_qa_unavailable";
  phase: "re_qa";
  derivedCandidateId: UUID;
  repairAttemptId: UUID;
};

export type S2Operation = {
  id: UUID;
  projectId: UUID;
  phase: "qa" | "repair" | "re_qa";
  attempt: 1 | 2;
  qaRunId: UUID;
  candidateId: UUID;
  repairAttemptId: UUID | null;
  inputHash: Sha256;
  referenceId: UUID;
  status: "queued" | "running" | "succeeded" | "failed";
  claimedBy: string | null;
  claimedProcessId: number | null;
  claimToken: UUID | null;
  claimedAt: Timestamp | null;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  failureCode: string | null;
  resultId: UUID | null;
};

export type S2PublicationObject = {
  key: string;
  sha256: Sha256;
  byteSize: number;
};

export type S2UploadPublication = {
  kind: "asset_upload";
  id: UUID;
  projectId: UUID;
  assetId: UUID;
  idempotencyKey: UUID;
  inputHash: Sha256;
  ownerProcessId: number;
  stagingObjects: S2PublicationObject[];
  finalObjects: S2PublicationObject[];
  intendedAsset: S2AssetRecord;
  state: "staged" | "promoted" | "committed" | "aborted";
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type S2RepairPublication = {
  kind: "repair_output";
  id: UUID;
  projectId: UUID;
  operationId: UUID;
  repairAttemptId: UUID;
  qaRunId: UUID;
  candidateId: UUID;
  inputVersionId: UUID;
  inputHash: Sha256;
  stagingObjects: S2PublicationObject[];
  finalObjects: S2PublicationObject[];
  intendedDerived: S2DerivedCandidate;
  intendedReQa: S2ReQaResult;
  intendedReQaOperation: S2Operation;
  providerRequestId: string | null;
  state: "staged" | "promoted" | "committed" | "aborted";
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type S2Publication = S2UploadPublication | S2RepairPublication;

export type S2StateTransition = {
  id: UUID;
  projectId: UUID;
  operationId: UUID;
  phase: S2Operation["phase"];
  attempt: 1 | 2;
  from: string;
  to: string;
  referenceId: UUID;
  at: Timestamp;
};
