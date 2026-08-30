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
  s3Sources: S3SourceSnapshot[];
  s3Selections: S3SelectionState[];
  s3SelectionEvents: S3SelectionEvent[];
  s3Revisions: S3Revision[];
  s3Assets: S3GeneratedAsset[];
  s3Cycles: S3RefinementCycle[];
  s3ImageOperations: S3ImageOperation[];
  s3Assessments: S3Assessment[];
  s3AssessmentAttempts: S3AssessmentAttempt[];
  s3Publications: S3Publication[];
  s3Transitions: S3StateTransition[];
  s4Stages: S4StageState[];
  s4Masks: S4MaskRecord[];
  s4Edits: S4EditAdmission[];
  s4Revisions: S4LocalEditRevision[];
  s4Assets: S4GeneratedAsset[];
  s4ImageOperations: S4ImageOperation[];
  s4PreservationChecks: S4PreservationCheck[];
  s4Assessments: S4Assessment[];
  s4AssessmentAttempts: S4AssessmentAttempt[];
  s4Publications: S4Publication[];
  s4Transitions: S4StateTransition[];
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

export type S2AssetKind = "reference" | "logo";
export type S2AssetStatus = "ready" | "deleted";
export type S2DraftStatus = "editable" | "frozen";
export type S2InputStatus = "bound";
export type S2QaRunStatus = "queued" | "running" | "completed";
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
export type S2ProviderDispatchState = "not_started" | "may_have_started" | "consumed";

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
  providerDispatchState: S2ProviderDispatchState;
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

export type S3SourceKind = "s1_original" | "s2_repaired";
export type S3SourceAssetKind = "s1_concept_asset" | "s2_derived_candidate";
export type S3SourceQualityStatus = "pass" | "warning";
export type S3SourceVerdict = "PASS" | "WARNING";
export type S3RevisionKind = "source_selection" | "refinement";
export type S3OutputAssetKind = "s1_concept_asset" | "s2_derived_candidate" | "s3_refinement_asset";
export type S3CycleStatus =
  | "image_queued"
  | "image_running"
  | "image_retry_available"
  | "publication_pending"
  | "assessment_pending"
  | "assessment_running"
  | "assessment_retry_available"
  | "completed"
  | "material_fail"
  | "qa_unavailable"
  | "image_failed"
  | "publication_failed"
  | "stale"
  | "waived";
export type S3CycleRetryState = "none" | "image_available" | "assessment_available" | "waived";
export type S3RetryWaivedReason = "reselected" | "rolled_back" | "later_cycle_started";
export type S3ImageOperationStatus = "queued" | "running" | "succeeded" | "failed";
export type S3AssessmentAggregateStatus =
  | "pending"
  | "running"
  | "pass"
  | "warning"
  | "material_fail"
  | "qa_unavailable_retryable"
  | "qa_unavailable_terminal";
export type S3AssessmentAttemptStatus = "queued" | "running" | "succeeded" | "failed";
export type S3AssessmentAttemptDisposition =
  | "pending"
  | "running"
  | "pass"
  | "warning"
  | "material_fail"
  | "qa_unavailable_retryable"
  | "qa_unavailable_terminal";
export type S3AssessmentRetryState = "none" | "available" | "waived";
export type S3PublicationStatus = "staged" | "promoted" | "committed" | "aborted";
export type S3ProviderDispatchState = "not_started" | "may_have_started" | "consumed";
export type S3SelectionEventKind = "select_source" | "reselect_source" | "activate_refinement" | "rollback";

export type S3OperationFailureCode =
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_SERVER_ERROR"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_MALFORMED_RESPONSE"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_CLIENT_ERROR"
  | "PROVIDER_DISPATCH_UNCERTAIN"
  | "IMAGE_EMPTY"
  | "IMAGE_MALFORMED"
  | "MEDIA_CORRUPT"
  | "MEDIA_NORMALIZATION_FAILED"
  | "S3_OUTPUT_DIMENSIONS_INVALID"
  | "IMAGE_INPUT_INTEGRITY_MISMATCH"
  | "MEDIA_TOO_LARGE"
  | "MEDIA_ANIMATED_NOT_ALLOWED"
  | "MEDIA_DIMENSIONS_EXCEEDED"
  | "MEDIA_PIXEL_LIMIT_EXCEEDED"
  | "MEDIA_SIGNATURE_MISMATCH"
  | "PUBLICATION_FAILED"
  | "PUBLICATION_OBJECT_MISMATCH"
  | "S3_FENCE_STALE"
  | "QA_PROVIDER_EMPTY"
  | "QA_PROVIDER_INCOMPLETE"
  | "QA_PROVIDER_REFUSED"
  | "QA_SCHEMA_INVALID"
  | "QA_RESULT_INCOMPLETE"
  | "QA_INPUT_INTEGRITY_MISMATCH"
  | "PERSISTENCE_FAILED";

export type CanonicalSourceBinding = {
  schemaVersion: "s3-source-binding-v1";
  projectId: UUID;
  generationSetId: UUID;
  candidateIndex: 1 | 2 | 3 | 4;
  sourceKind: S3SourceKind;
  sourceCandidateId: UUID;
  ultimateS1CandidateId: UUID;
  ultimateS1AssetId: UUID;
  selectedAssetKind: S3SourceAssetKind;
  selectedAssetId: UUID;
  selectedSha256: Sha256;
  selectedByteSize: number;
  selectedWidth: number;
  selectedHeight: number;
  selectedPixelCount: number;
  selectedDecodedRgbaBytes: number;
  s1CompilerVersion: "g2-booth-v1";
  s1DirectionKey: CandidateDirection;
  s1CanonicalInputHash: Sha256;
  s1PromptHash: Sha256;
  s1Provider: "openai";
  s1ImageModelSnapshot: "gpt-image-2-2026-04-21";
  confirmedBriefVersionId: UUID;
  confirmedBriefContentHash: Sha256;
  s2InputVersionId: UUID;
  s2InputBindingHash: Sha256;
  s2QaRunId: UUID;
  s2SourceQaResultId: UUID;
  s2QaModelSnapshot: "gpt-5.4-mini-2026-03-17";
  s2RepairAttemptId: UUID | null;
  s2ReQaResultId: UUID | null;
  s2DerivedCandidateId: UUID | null;
  s2RepairInputHash: Sha256 | null;
  s2RepairPromptHash: Sha256 | null;
  s2RepairModelSnapshot: "gpt-image-2-2026-04-21" | null;
  eligibilityResultId: UUID;
  eligibilityStatus: S3SourceQualityStatus;
  eligibilityVerdict: S3SourceVerdict;
};

export type S3SourceSnapshot = {
  sourceSnapshotId: UUID;
  sourceRootRevisionId: UUID;
  projectId: UUID;
  generationSetId: UUID;
  candidateIndex: 1 | 2 | 3 | 4;
  sourceKind: S3SourceKind;
  canonicalSourceBinding: CanonicalSourceBinding;
  sourceBindingHash: Sha256;
  selectedAssetKind: S3SourceAssetKind;
  selectedAssetId: UUID;
  selectedStorageKey: string;
  selectedSha256: Sha256;
  selectedByteSize: number;
  selectedWidth: number;
  selectedHeight: number;
  selectedPixelCount: number;
  selectedDecodedRgbaBytes: number;
  confirmedBriefVersionId: UUID;
  confirmedBriefContentHash: Sha256;
  s2InputVersionId: UUID;
  s2InputBindingHash: Sha256;
  geometrySnapshot: BoothGeometry;
  geometryHash: Sha256;
  canonicalRequirements: S2Requirement[];
  requirementHash: Sha256;
  designRulesVersion: "s2-design-rules-v1";
  designRuleSnapshot: S2DesignRuleSnapshot[];
  designRuleSnapshotHash: Sha256;
  createdAt: Timestamp;
};

export type S3SelectionState = {
  selectionStateId: UUID;
  projectId: UUID;
  generationSetId: UUID;
  confirmedBriefVersionId: UUID;
  confirmedBriefContentHash: Sha256;
  s2InputVersionId: UUID;
  s2InputBindingHash: Sha256;
  geometrySnapshot: BoothGeometry;
  geometryHash: Sha256;
  activeRevisionId: UUID | null;
  lineageRootRevisionId: UUID | null;
  selectionVersion: number;
  cycleSlotsConsumed: 0 | 1 | 2;
  successfulRefinementCount: 0 | 1 | 2;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type S3SelectionEvent = {
  eventId: UUID;
  projectId: UUID;
  selectionStateId: UUID;
  kind: S3SelectionEventKind;
  fromRevisionId: UUID | null;
  toRevisionId: UUID;
  sourceSnapshotId: UUID;
  cycleId: UUID | null;
  assessmentId: UUID | null;
  expectedSelectionVersion: number;
  resultingSelectionVersion: number;
  resultingSuccessfulRefinementCount: 0 | 1 | 2;
  idempotencyKey: UUID | null;
  requestReferenceId: UUID;
  at: Timestamp;
};

export type S3ImageProviderMetadata = {
  provider: "openai";
  api: "images";
  model: "gpt-image-2";
  modelSnapshot: "gpt-image-2-2026-04-21";
  providerRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  receivedAt: Timestamp;
};

export type S3AssessmentProviderMetadata = {
  provider: "openai";
  api: "responses";
  model: "gpt-5.4-mini";
  modelSnapshot: "gpt-5.4-mini-2026-03-17";
  providerRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  receivedAt: Timestamp;
};

export type S3RevisionCommon = {
  revisionId: UUID;
  projectId: UUID;
  generationSetId: UUID;
  confirmedBriefVersionId: UUID;
  confirmedBriefContentHash: Sha256;
  geometrySnapshot: BoothGeometry;
  geometryHash: Sha256;
  s2InputVersionId: UUID;
  s2InputBindingHash: Sha256;
  sourceSnapshotId: UUID;
  sourceBindingHash: Sha256;
  ultimateS1CandidateId: UUID;
  sourceS2QaResultId: UUID;
  sourceS2RepairAttemptId: UUID | null;
  sourceS2ReQaResultId: UUID | null;
  sourceS2DerivedCandidateId: UUID | null;
  outputAssetId: UUID;
  outputSha256: Sha256;
  outputByteSize: number;
  outputWidth: number;
  outputHeight: number;
  outputPixelCount: number;
  createdAt: Timestamp;
};

export type S3SourceRevision = S3RevisionCommon & {
  kind: "source_selection";
  lineageRootRevisionId: UUID;
  parentRevisionId: null;
  refinementCycleNumber: 0;
  refinementIntentText: null;
  refinementIntentHash: null;
  refinementInputHash: null;
  compilerVersion: null;
  promptHash: null;
  providerMetadata: null;
  outputAssetKind: "s1_concept_asset" | "s2_derived_candidate";
  assessmentId: null;
};

export type S3RefinementRevision = S3RevisionCommon & {
  kind: "refinement";
  lineageRootRevisionId: UUID;
  parentRevisionId: UUID;
  refinementCycleNumber: 1 | 2;
  refinementIntentText: string;
  refinementIntentHash: Sha256;
  refinementInputHash: Sha256;
  compilerVersion: "s3-refinement-v1";
  promptHash: Sha256;
  providerMetadata: S3ImageProviderMetadata;
  outputAssetKind: "s3_refinement_asset";
  assessmentId: UUID;
};

export type S3Revision = S3SourceRevision | S3RefinementRevision;

export type S3GeneratedAsset = {
  assetId: UUID;
  projectId: UUID;
  revisionId: UUID;
  generationSetId: UUID;
  mediaProfile: "s2-media-v1";
  providerOutputSha256: Sha256;
  providerOutputBytes: number;
  detectedMime: "image/png";
  normalizedSha256: Sha256;
  normalizedBytes: number;
  width: 1536;
  height: 1024;
  pixelCount: 1_572_864;
  hasAlpha: boolean;
  storageKeyNormalized: string;
  createdAt: Timestamp;
};

export type S3RefinementCycle = {
  cycleId: UUID;
  projectId: UUID;
  selectionStateId: UUID;
  generationSetId: UUID;
  lineageRootRevisionId: UUID;
  cycleNumber: 1 | 2;
  baseRevisionId: UUID;
  baseSelectionVersion: number;
  refinementIntentText: string;
  refinementIntentHash: Sha256;
  refinementInputHash: Sha256;
  compilerVersion: "s3-refinement-v1";
  promptHash: Sha256;
  status: S3CycleStatus;
  retryState: S3CycleRetryState;
  retryWaivedReason: S3RetryWaivedReason | null;
  imageOperationIds: readonly [UUID] | readonly [UUID, UUID];
  outputRevisionId: UUID | null;
  assessmentId: UUID | null;
  assessmentAttemptIds: readonly [] | readonly [UUID] | readonly [UUID, UUID];
  createdAt: Timestamp;
  admittedAt: Timestamp;
  updatedAt: Timestamp;
  terminalAt: Timestamp | null;
};

export type S3ImageOperation = {
  operationId: UUID;
  projectId: UUID;
  cycleId: UUID;
  generationSetId: UUID;
  baseRevisionId: UUID;
  baseSelectionVersion: number;
  attempt: 1 | 2;
  retryOfOperationId: UUID | null;
  operationInputHash: Sha256;
  refinementInputHash: Sha256;
  promptHash: Sha256;
  requestReferenceId: UUID;
  status: S3ImageOperationStatus;
  claimedBy: string | null;
  claimedProcessId: number | null;
  claimToken: UUID | null;
  claimedAt: Timestamp | null;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  providerDispatchState: S3ProviderDispatchState;
  providerMetadata: S3ImageProviderMetadata | null;
  failureCode: S3OperationFailureCode | null;
  publicationId: UUID | null;
  outputRevisionId: UUID | null;
  outputAssetId: UUID | null;
  createdAt: Timestamp;
};

export type S3Assessment = {
  assessmentId: UUID;
  projectId: UUID;
  generationSetId: UUID;
  sourceSnapshotId: UUID;
  revisionId: UUID;
  outputAssetId: UUID;
  outputSha256: Sha256;
  outputByteSize: number;
  outputWidth: 1536;
  outputHeight: 1024;
  outputPixelCount: 1_572_864;
  sourceS2QaResultId: UUID;
  sourceS2ReQaResultId: UUID | null;
  s2InputVersionId: UUID;
  confirmedBriefVersionId: UUID;
  confirmedBriefContentHash: Sha256;
  geometrySnapshot: BoothGeometry;
  geometryHash: Sha256;
  canonicalRequirements: S2Requirement[];
  requirementHash: Sha256;
  designRulesVersion: "s2-design-rules-v1";
  designRuleSnapshot: S2DesignRuleSnapshot[];
  designRuleSnapshotHash: Sha256;
  sourceBindingHash: Sha256;
  refinementInputHash: Sha256;
  refinementIntentHash: Sha256;
  assessmentCompilerVersion: "s3-assessment-v1";
  assessmentSchema: "s3-assessment-v1";
  assessmentSchemaName: "s3_assessment_v1";
  assessmentInputHash: Sha256;
  assessmentPromptHash: Sha256;
  attemptIds: readonly [UUID] | readonly [UUID, UUID];
  latestAttemptId: UUID;
  status: S3AssessmentAggregateStatus;
  retryState: S3AssessmentRetryState;
  retryWaivedReason: S3RetryWaivedReason | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type S3AssessmentAttempt = {
  assessmentAttemptId: UUID;
  assessmentId: UUID;
  projectId: UUID;
  revisionId: UUID;
  outputAssetId: UUID;
  outputSha256: Sha256;
  outputByteSize: number;
  outputWidth: 1536;
  outputHeight: 1024;
  outputPixelCount: 1_572_864;
  attempt: 1 | 2;
  retryOfAttemptId: UUID | null;
  operationInputHash: Sha256;
  assessmentInputHash: Sha256;
  assessmentPromptHash: Sha256;
  assessmentCompilerVersion: "s3-assessment-v1";
  assessmentSchema: "s3-assessment-v1";
  assessmentSchemaName: "s3_assessment_v1";
  requestReferenceId: UUID;
  status: S3AssessmentAttemptStatus;
  disposition: S3AssessmentAttemptDisposition;
  claimedBy: string | null;
  claimedProcessId: number | null;
  claimToken: UUID | null;
  claimedAt: Timestamp | null;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  providerDispatchState: S3ProviderDispatchState;
  requirementObservations: S2RequirementObservation[];
  designObservations: S2DesignObservation[];
  materialFindingIds: string[];
  warningFindingIds: string[];
  uncertainFindingIds: string[];
  failureCode: S3OperationFailureCode | null;
  providerMetadata: S3AssessmentProviderMetadata | null;
  createdAt: Timestamp;
};

export type S3PublicationObject = {
  key: string;
  sha256: Sha256;
  byteSize: number;
  width: 1536;
  height: 1024;
  pixelCount: 1_572_864;
};

export type S3Publication = {
  publicationId: UUID;
  projectId: UUID;
  cycleId: UUID;
  operationId: UUID;
  inputHash: Sha256;
  providerOutputSha256: Sha256;
  providerOutputBytes: number;
  normalizedSha256: Sha256;
  normalizedBytes: number;
  width: 1536;
  height: 1024;
  pixelCount: 1_572_864;
  hasAlpha: boolean;
  intendedAssetId: UUID;
  intendedRevisionId: UUID;
  intendedAssessmentId: UUID;
  intendedAssessmentAttemptId: UUID;
  stagingObjects: readonly [S3PublicationObject];
  finalObjects: readonly [S3PublicationObject];
  ownerProcessId: number | null;
  ownerClaimToken: UUID | null;
  ownerClaimedAt: Timestamp | null;
  state: S3PublicationStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type S3TransitionValue =
  | S3CycleStatus
  | S3ImageOperationStatus
  | S3AssessmentAggregateStatus
  | S3AssessmentAttemptStatus
  | S3AssessmentAttemptDisposition
  | S3PublicationStatus
  | S3CycleRetryState
  | S3AssessmentRetryState
  | S3SelectionEventKind;

export type S3StateTransition = {
  transitionId: UUID;
  projectId: UUID;
  cycleId: UUID | null;
  operationId: UUID | null;
  assessmentId: UUID | null;
  assessmentAttemptId: UUID | null;
  publicationId: UUID | null;
  phase: "selection" | "cycle" | "image" | "publication" | "assessment";
  attempt: 1 | 2 | null;
  from: S3TransitionValue | null;
  to: S3TransitionValue;
  reason: S3RetryWaivedReason | null;
  requestReferenceId: UUID;
  at: Timestamp;
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

export type BoothGeometrySnapshot = {
  widthMm: number;
  depthMm: number;
  openSides: OpenSide[];
  maxHeightMm: number | null;
};

export type S4SourceQualityProof =
  | { kind: "s3_source"; sourceSnapshotId: UUID; sourceRevisionId: UUID; sourceBindingHash: Sha256; status: "PASS" | "WARNING"; verdictRecordId: UUID }
  | { kind: "s3_refinement"; sourceSnapshotId: UUID; sourceRevisionId: UUID; sourceBindingHash: Sha256; assessmentId: UUID; status: "PASS" | "WARNING"; verdictRecordId: UUID }
  | { kind: "s4_local_edit"; sourceSnapshotId: UUID; sourceRevisionId: UUID; preservationCheckId: UUID; assessmentId: UUID; status: "PASS" | "WARNING"; verdictRecordId: UUID };

export type S4Requirement = {
  requirementId: string;
  category: "geometry" | "functional" | "mandatory" | "prohibited" | "free_text";
  expected: "present" | "absent" | "exact_count";
  expectedCount: number | null;
  expectedValue: string | number | boolean | null;
  criticality: "material" | "warning";
  source: "confirmed_brief" | "geometry_snapshot";
  text: string;
};

export type S4DesignRuleSnapshot = {
  ruleId: string;
  applicability: "applicable" | "not_applicable";
  materiality: "material" | "warning";
  repairable: boolean;
};

export type S4RequirementObservation = {
  requirementId: string;
  expected: "present" | "absent" | "exact_count";
  expectedCount: number | null;
  expectedValue: string | number | boolean | null;
  observed: "present" | "absent" | "uncertain" | "not_verifiable";
  observedCount: number | null;
  confidence: number;
  evidence: string;
};

export type S4DesignObservation = {
  ruleId: string;
  observed: "compliant" | "non_compliant" | "uncertain" | "not_verifiable";
  confidence: number;
  evidence: string;
};

export type S4ImageProviderMetadata = {
  provider: "openai";
  api: "images";
  model: "gpt-image-2";
  modelSnapshot: "gpt-image-2-2026-04-21";
  providerRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  receivedAt: Timestamp;
};

export type S4AssessmentProviderMetadata = {
  provider: "openai";
  api: "responses";
  model: "gpt-5.4-mini";
  modelSnapshot: "gpt-5.4-mini-2026-03-17";
  providerRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type S4FailureCode =
  | "PROVIDER_TIMEOUT" | "PROVIDER_UNAVAILABLE" | "PROVIDER_RATE_LIMIT" | "PROVIDER_SERVER_ERROR"
  | "PROVIDER_HTTP_ERROR" | "PROVIDER_MALFORMED_RESPONSE" | "PROVIDER_NOT_CONFIGURED" | "PROVIDER_CLIENT_ERROR"
  | "PROVIDER_DISPATCH_UNCERTAIN" | "IMAGE_EMPTY" | "IMAGE_MALFORMED" | "MEDIA_CORRUPT"
  | "MEDIA_NORMALIZATION_FAILED" | "S4_OUTPUT_DIMENSIONS_INVALID" | "S4_IMAGE_INPUT_INTEGRITY_MISMATCH"
  | "MEDIA_TOO_LARGE" | "MEDIA_ANIMATED_NOT_ALLOWED" | "MEDIA_DIMENSIONS_EXCEEDED" | "MEDIA_PIXEL_LIMIT_EXCEEDED"
  | "MEDIA_SIGNATURE_MISMATCH" | "PUBLICATION_FAILED" | "PUBLICATION_OBJECT_MISMATCH" | "S4_FENCE_STALE"
  | "S4_MASK_INVALID" | "S4_MASK_COMPARISON_TOO_SMALL" | "S4_PRESERVATION_DECODE_FAILED" | "S4_NOOP_OUTPUT"
  | "QA_PROVIDER_EMPTY" | "QA_PROVIDER_INCOMPLETE" | "QA_PROVIDER_REFUSED" | "QA_SCHEMA_INVALID"
  | "QA_RESULT_INCOMPLETE" | "QA_INPUT_INTEGRITY_MISMATCH" | "PERSISTENCE_FAILED";

export type S4MaskPrimitive =
  | { kind: "rectangle"; xQ16: number; yQ16: number; widthQ16: number; heightQ16: number }
  | { kind: "brush"; radiusQ8: number; points: Array<{ xQ16: number; yQ16: number }> };

export type S4StageState = {
  stageId: UUID;
  projectId: UUID;
  generationSetId: UUID;
  selectionStateId: UUID;
  sourceSnapshotId: UUID;
  lineageRootRevisionId: UUID;
  status: "started";
  s3RefinementClosed: true;
  cyclesConsumed: 0 | 1 | 2;
  firstEditId: UUID;
  createdAt: Timestamp;
  startedAt: Timestamp;
  updatedAt: Timestamp;
};

export type S4MaskRecord = {
  maskId: UUID;
  editId: UUID;
  projectId: UUID;
  generationSetId: UUID;
  selectionStateId: UUID;
  sourceRevisionId: UUID;
  sourceAssetId: UUID;
  schemaVersion: "s4-mask-raster-v1";
  width: 1536;
  height: 1024;
  pixelCount: 1572864;
  protectedValue: 0;
  editableValue: 255;
  layout: "row-major-top-left-one-byte-per-pixel";
  primitives: S4MaskPrimitive[];
  primitiveCount: number;
  brushPointCount: number;
  primitiveHash: Sha256;
  rasterSha256: Sha256;
  rasterBytes: 1572864;
  rasterStorageKey: string;
  providerPngVersion: "s4-mask-png-v1";
  providerPngSha256: Sha256;
  providerPngBytes: number;
  providerPngStorageKey: string;
  editablePixelCount: number;
  protectedPixelCount: number;
  comparisonPixelCount: number;
  maskIdentityHash: Sha256;
  createdAt: Timestamp;
};

export type S4EditStatus =
  | "mask_materialization_pending" | "image_queued" | "image_running" | "image_retry_available"
  | "publication_pending" | "preservation_pending" | "preservation_running" | "assessment_pending"
  | "assessment_running" | "assessment_retry_available" | "completed" | "material_fail"
  | "qa_unavailable" | "image_failed" | "publication_failed" | "stale" | "waived";
export type S4RetryState = "none" | "image_available" | "assessment_available" | "waived";
export type S4RetryWaivedReason = "rolled_back" | "later_cycle_started" | "selection_moved";

export type S4EditAdmission = {
  editId: UUID;
  projectId: UUID;
  generationSetId: UUID;
  selectionStateId: UUID;
  sourceSnapshotId: UUID;
  lineageRootRevisionId: UUID;
  cycleNumber: 1 | 2;
  baseRevisionId: UUID;
  baseRevisionKind: "s3" | "s4";
  baseSelectionVersion: number;
  maskId: UUID;
  maskIdentityHash: Sha256;
  maskMaterializationStatus: "pending" | "ready";
  instructionText: string;
  instructionHash: Sha256;
  compilerVersion: "s4-local-edit-v1";
  editInputHash: Sha256;
  promptHash: Sha256;
  providerRequestHash: Sha256;
  imageOperationIds: readonly [] | readonly [UUID] | readonly [UUID, UUID];
  outputRevisionId: UUID | null;
  preservationCheckId: UUID | null;
  assessmentId: UUID | null;
  assessmentAttemptIds: readonly [] | readonly [UUID] | readonly [UUID, UUID];
  status: S4EditStatus;
  retryState: S4RetryState;
  retryWaivedReason: S4RetryWaivedReason | null;
  createdAt: Timestamp;
  admittedAt: Timestamp;
  updatedAt: Timestamp;
  terminalAt: Timestamp | null;
};

export type S4LocalEditRevision = {
  revisionId: UUID;
  kind: "s4_local_edit";
  projectId: UUID;
  generationSetId: UUID;
  selectionStateId: UUID;
  sourceSnapshotId: UUID;
  lineageRootRevisionId: UUID;
  parentRevisionId: UUID;
  parentRevisionKind: "s3" | "s4";
  cycleNumber: 1 | 2;
  editId: UUID;
  maskId: UUID;
  maskIdentityHash: Sha256;
  instructionText: string;
  instructionHash: Sha256;
  compilerVersion: "s4-local-edit-v1";
  editInputHash: Sha256;
  promptHash: Sha256;
  providerRequestHash: Sha256;
  sourceQuality: S4SourceQualityProof;
  sourceAssetId: UUID;
  sourceSha256: Sha256;
  sourceByteSize: number;
  sourceWidth: 1536;
  sourceHeight: 1024;
  sourcePixelCount: 1572864;
  outputAssetId: UUID;
  outputSha256: Sha256;
  outputByteSize: number;
  outputWidth: 1536;
  outputHeight: 1024;
  outputPixelCount: 1572864;
  outputMediaProfile: "s2-media-v1";
  preservationCheckId: UUID;
  assessmentId: UUID;
  createdAt: Timestamp;
};

export type S4GeneratedAsset = {
  assetId: UUID;
  projectId: UUID;
  generationSetId: UUID;
  revisionId: UUID;
  mediaProfile: "s2-media-v1";
  providerOutputSha256: Sha256;
  providerOutputBytes: number;
  detectedMime: "image/png";
  normalizedSha256: Sha256;
  normalizedBytes: number;
  width: 1536;
  height: 1024;
  pixelCount: 1572864;
  hasAlpha: boolean;
  storageKeyNormalized: string;
  createdAt: Timestamp;
};

export type S4ProviderDispatchState = "not_started" | "may_have_started" | "consumed";
export type S4ImageOperationStatus = "queued" | "running" | "succeeded" | "failed";

export type S4ImageOperation = {
  operationId: UUID;
  projectId: UUID;
  editId: UUID;
  generationSetId: UUID;
  selectionStateId: UUID;
  baseRevisionId: UUID;
  baseSelectionVersion: number;
  attempt: 1 | 2;
  retryOfOperationId: UUID | null;
  operationInputHash: Sha256;
  editInputHash: Sha256;
  promptHash: Sha256;
  providerRequestHash: Sha256;
  requestReferenceId: UUID;
  status: S4ImageOperationStatus;
  claimedBy: string | null;
  claimedProcessId: number | null;
  claimToken: UUID | null;
  claimedAt: Timestamp | null;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  providerDispatchState: S4ProviderDispatchState;
  providerMetadata: S4ImageProviderMetadata | null;
  failureCode: S4FailureCode | null;
  publicationId: UUID | null;
  outputRevisionId: UUID | null;
  outputAssetId: UUID | null;
  createdAt: Timestamp;
};

export type S4PreservationStatus = "pending" | "running" | "PASS" | "MATERIAL_FAIL" | "QA_UNAVAILABLE";
export type S4PreservationSeverity = "none" | "tiny" | "material" | "catastrophic";
export type S4EvidenceObject = { key: string; sha256: Sha256; byteSize: number };

export type S4PreservationCheck = {
  preservationCheckId: UUID;
  projectId: UUID;
  generationSetId: UUID;
  selectionStateId: UUID;
  editId: UUID;
  revisionId: UUID;
  sourceRevisionId: UUID;
  sourceAssetId: UUID;
  sourceSha256: Sha256;
  outputAssetId: UUID;
  outputSha256: Sha256;
  maskId: UUID;
  maskIdentityHash: Sha256;
  decoderProfile: "s4-rgba-v1";
  width: 1536;
  height: 1024;
  pixelCount: 1572864;
  guardRadiusPx: 6;
  rgbChannelTolerance: 8;
  alphaTolerance: 8;
  comparisonPixelMinimum: 65536;
  comparedPixelCount: number;
  differingPixelCount: number;
  rgbDifferingPixelCount: number;
  alphaDifferingPixelCount: number;
  maxRgbDelta: number;
  maxAlphaDelta: number;
  aggregateDelta: number;
  meanAggregateDeltaQ16: number;
  componentCount: number;
  largestComponentPixelCount: number;
  severity: S4PreservationSeverity;
  noOpDetected: boolean | null;
  status: S4PreservationStatus;
  failureCode: S4FailureCode | null;
  evidenceObject: S4EvidenceObject | null;
  claimedBy: string | null;
  claimedProcessId: number | null;
  claimToken: UUID | null;
  claimedAt: Timestamp | null;
  createdAt: Timestamp;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
};

export type S4AssessmentStatus =
  | "not_started" | "pending" | "running" | "pass" | "warning" | "material_fail"
  | "qa_unavailable_retryable" | "qa_unavailable_terminal" | "skipped_preservation_fail";
export type S4AssessmentRetryState = "none" | "available" | "waived";
export type S4Satisfaction = "satisfied" | "not_satisfied" | "uncertain" | "not_verifiable";

export type S4Assessment = {
  assessmentId: UUID;
  projectId: UUID;
  generationSetId: UUID;
  selectionStateId: UUID;
  editId: UUID;
  revisionId: UUID;
  sourceRevisionId: UUID;
  outputAssetId: UUID;
  sourceSha256: Sha256;
  outputSha256: Sha256;
  maskId: UUID;
  maskIdentityHash: Sha256;
  instructionHash: Sha256;
  sourceQuality: S4SourceQualityProof;
  confirmedBriefVersionId: UUID;
  confirmedBriefContentHash: Sha256;
  geometrySnapshot: BoothGeometrySnapshot;
  geometryHash: Sha256;
  canonicalRequirements: S4Requirement[];
  requirementHash: Sha256;
  designRulesVersion: "s2-design-rules-v1";
  designRuleSnapshot: S4DesignRuleSnapshot[];
  designRuleSnapshotHash: Sha256;
  assessmentCompilerVersion: "s4-assessment-v1";
  assessmentSchema: "s4-assessment-v1";
  assessmentSchemaName: "s4_local_edit_assessment_v1";
  assessmentInputHash: Sha256;
  assessmentPromptHash: Sha256;
  attemptIds: readonly [] | readonly [UUID] | readonly [UUID, UUID];
  latestAttemptId: UUID | null;
  noOpDetected: boolean;
  requestedEditSatisfaction: S4Satisfaction | null;
  overallRequirementResult: "satisfied" | "not_satisfied" | "uncertain" | "not_verifiable" | null;
  overallBuildabilityResult: "buildable" | "not_buildable" | "uncertain" | "not_verifiable" | null;
  status: S4AssessmentStatus;
  retryState: S4AssessmentRetryState;
  retryWaivedReason: S4RetryWaivedReason | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type S4AssessmentAttemptStatus = "queued" | "running" | "succeeded" | "failed";
export type S4AssessmentAttemptDisposition = "pending" | "running" | "pass" | "warning" | "material_fail" | "qa_unavailable_retryable" | "qa_unavailable_terminal";

export type S4AssessmentAttempt = {
  assessmentAttemptId: UUID;
  assessmentId: UUID;
  projectId: UUID;
  generationSetId: UUID;
  selectionStateId: UUID;
  editId: UUID;
  revisionId: UUID;
  outputAssetId: UUID;
  sourceSha256: Sha256;
  outputSha256: Sha256;
  maskIdentityHash: Sha256;
  instructionHash: Sha256;
  assessmentInputHash: Sha256;
  assessmentPromptHash: Sha256;
  assessmentCompilerVersion: "s4-assessment-v1";
  assessmentSchema: "s4-assessment-v1";
  assessmentSchemaName: "s4_local_edit_assessment_v1";
  operationInputHash: Sha256;
  attempt: 1 | 2;
  retryOfAttemptId: UUID | null;
  requestReferenceId: UUID;
  status: S4AssessmentAttemptStatus;
  disposition: S4AssessmentAttemptDisposition;
  claimedBy: string | null;
  claimedProcessId: number | null;
  claimToken: UUID | null;
  claimedAt: Timestamp | null;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  providerDispatchState: S4ProviderDispatchState;
  requirementObservations: S4RequirementObservation[];
  designObservations: S4DesignObservation[];
  requestedEditSatisfaction: S4Satisfaction | null;
  overallRequirementResult: S4Assessment["overallRequirementResult"];
  overallBuildabilityResult: S4Assessment["overallBuildabilityResult"];
  materialFindingIds: string[];
  warningFindingIds: string[];
  uncertainFindingIds: string[];
  failureCode: S4FailureCode | null;
  providerMetadata: S4AssessmentProviderMetadata | null;
  evidenceObject: S4EvidenceObject | null;
  createdAt: Timestamp;
};

export type S4PublicationObject = { key: string; sha256: Sha256; byteSize: number };
export type S4PublicationStatus = "staged" | "promoted" | "committed" | "aborted";
export type S4Publication = {
  publicationId: UUID;
  projectId: UUID;
  generationSetId: UUID;
  selectionStateId: UUID;
  editId: UUID;
  operationId: UUID;
  inputHash: Sha256;
  providerOutputSha256: Sha256;
  providerOutputBytes: number;
  normalizedSha256: Sha256;
  normalizedBytes: number;
  width: 1536;
  height: 1024;
  pixelCount: 1572864;
  intendedAssetId: UUID;
  intendedRevisionId: UUID;
  intendedPreservationCheckId: UUID;
  intendedAssessmentId: UUID;
  stagingObjects: readonly [S4PublicationObject];
  finalObjects: readonly [S4PublicationObject];
  ownerProcessId: number | null;
  ownerClaimToken: UUID | null;
  ownerClaimedAt: Timestamp | null;
  state: S4PublicationStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type S4TransitionPhase = "stage" | "edit" | "image" | "publication" | "preservation" | "assessment" | "activation" | "rollback";
export type S4TransitionValue = "not_started" | "started" | "image_queued" | "image_running" | "image_retry_available" | "publication_pending" | "preservation_pending" | "preservation_running" | "assessment_pending" | "assessment_running" | "assessment_retry_available" | "completed" | "material_fail" | "qa_unavailable" | "image_failed" | "publication_failed" | "stale" | "waived" | "mask_materialization_pending" | "queued" | "running" | "succeeded" | "failed" | "pending" | "pass" | "warning" | "qa_unavailable_retryable" | "qa_unavailable_terminal" | "skipped_preservation_fail" | "PASS" | "WARNING" | "MATERIAL_FAIL" | "QA_UNAVAILABLE" | "activation" | "rollback";
export type S4TransitionReason = "admitted" | "s3_closed" | "image_started" | "image_succeeded" | "image_failed" | "image_retry_admitted" | "publication_started" | "publication_committed" | "publication_aborted" | "mask_materialization_verified" | "preservation_started" | "preservation_pass" | "preservation_material_fail" | "preservation_unavailable" | "assessment_started" | "assessment_pass" | "assessment_warning" | "assessment_material_fail" | "assessment_unavailable" | "assessment_retry_admitted" | "activation" | "activation_stale" | "rollback" | "retry_waived" | "fence_stale" | "no_op";
export type S4StateTransition = {
  transitionId: UUID;
  projectId: UUID;
  generationSetId: UUID;
  selectionStateId: UUID;
  editId: UUID | null;
  operationId: UUID | null;
  publicationId: UUID | null;
  preservationCheckId: UUID | null;
  assessmentId: UUID | null;
  assessmentAttemptId: UUID | null;
  phase: S4TransitionPhase;
  attempt: 1 | 2 | null;
  from: S4TransitionValue | null;
  to: S4TransitionValue;
  reason: S4TransitionReason | null;
  priorRevisionId: UUID | null;
  resultingRevisionId: UUID | null;
  expectedSelectionVersion: number | null;
  resultingSelectionVersion: number | null;
  requestReferenceId: UUID;
  at: Timestamp;
};

export type S4ToS5Handoff = {
  projectId: UUID;
  generationSetId: UUID;
  selectionStateId: UUID;
  selectionVersion: number;
  activeRevisionId: UUID;
  activeRevisionKind: "s3" | "s4";
  sourceSnapshotId: UUID;
  lineageRootRevisionId: UUID;
  activeAssetId: UUID;
  activeAssetSha256: Sha256;
  activeAssetByteSize: number;
  activeAssetStorageKey: string;
  width: 1536;
  height: 1024;
  pixelCount: 1572864;
  quality: "PASS" | "WARNING";
  confirmedBriefVersionId: UUID;
  confirmedBriefContentHash: Sha256;
  geometrySnapshot: BoothGeometrySnapshot;
  geometryHash: Sha256;
  canonicalRequirements: S4Requirement[];
  requirementHash: Sha256;
  designRulesVersion: "s2-design-rules-v1";
  designRuleSnapshot: S4DesignRuleSnapshot[];
  designRuleSnapshotHash: Sha256;
  s4StageStatus: "not_started" | "started";
  s4CyclesConsumed: 0 | 1 | 2;
};
