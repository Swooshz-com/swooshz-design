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
