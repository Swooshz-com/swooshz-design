import {
  AppError,
  type BriefAsset,
  type ConceptAsset,
  type ConceptCandidate,
  type ExtractionOperation,
  type GenerationOperation,
  type GenerationRequest,
  type GenerationSet,
  type IdempotencyRecord,
  type Project,
  type Sha256,
  type StoreState,
  type StructuredBriefData,
  type StructuredBriefDraft,
  type StructuredBriefVersion,
  type UserConfirmedBrief,
  type UUID,
} from "./types";
import { assertBriefData, normalizeProviderBriefData } from "./schema";
import { geometryIsValid, validateGeometry } from "./geometry";
import { validatePdfUpload, validatePng, type PdfUpload } from "./media";
import {
  COMPILER_VERSION,
  DIRECTIONS,
  IMAGE_MODEL_SNAPSHOT,
  compilePrompt,
  compilerInputHash,
  promptManifestHash,
} from "./compiler";
import {
  OpenAIProvider,
  type ImageProviderResult,
  type OpenAIProviderContract,
  providerErrorToCode,
} from "./openai";
import { JsonRepository, PrivateObjectStore, defaultDataRoot } from "./store";
import { assertUuid, cloneJson, jcs, newUuid, nowUtc, privateStorageKey, sha256 } from "./utils";
import { S2WorkflowService, type S2WorkflowServiceOptions } from "./s2";
import { S3WorkflowService, type S3WorkflowServiceOptions } from "./s3";
import type { S3ProviderContract } from "./s3-provider";
import { S4WorkflowService, type S4WorkflowServiceOptions } from "./s4";
import type { S4ProviderContract } from "./s4-provider";


export type WorkflowServiceOptions = {
  repository?: JsonRepository;
  objects?: PrivateObjectStore;
  dataRoot?: string;
  provider?: OpenAIProviderContract;
  s3Provider?: S3ProviderContract;
  s4Provider?: S4ProviderContract;
  clock?: () => string;
  uuid?: () => UUID;
  workerId?: string;
  processId?: number;
  isProcessAlive?: (processId: number) => boolean;
  onProviderDispatchPhase?: S2WorkflowServiceOptions["onProviderDispatchPhase"];
  onPublicationPhase?: S2WorkflowServiceOptions["onPublicationPhase"];
  onS3ProviderDispatchPhase?: S3WorkflowServiceOptions["onProviderDispatchPhase"];
  onS3PublicationPhase?: S3WorkflowServiceOptions["onPublicationPhase"];
  onS4ProviderDispatchPhase?: S4WorkflowServiceOptions["onProviderDispatchPhase"];
  onS4PublicationPhase?: S4WorkflowServiceOptions["onPublicationPhase"];
};

export type PublicGeneration = {
  generationSet: GenerationSet;
  candidates: ConceptCandidate[];
  retryEligible: boolean;
};

export type UploadResult = {
  asset: BriefAsset;
  project: Project;
};

export type PublicBriefState = {
  project: Project;
  asset: {
    assetId: UUID;
    originalFileName: string;
    byteSize: number;
    pageCount: number;
    status: "stored";
  } | null;
  extractionStatus: ExtractionOperation["status"] | null;
  extractionRetryEligible: boolean;
};

export type S1Route = "geometry" | "brief" | "review" | "generate" | "generation" | "s2";

function operationInputHash(operation: string, projectId: UUID, input: unknown): Sha256 {
  return sha256(jcs({ operation, projectId, input }));
}

function safeResult(value: Record<string, unknown>): Record<string, unknown> {
  return cloneJson(value);
}

function pendingOperation(status: string): boolean {
  return status === "queued" || status === "running";
}

function processIsAlive(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) return true;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

export function projectContinuationPath(
  project: Project,
  requested: S1Route,
  generationSetId?: UUID,
): string | null {
  const current = (() => {
    switch (project.status) {
      case "draft":
        return "/projects/" + project.projectId + "/geometry";
      case "geometry_ready":
      case "extracting":
      case "brief_extraction_failed":
        return "/projects/" + project.projectId + "/brief";
      case "brief_review":
        return "/projects/" + project.projectId + "/brief/review";
      case "brief_confirmed":
        return "/projects/" + project.projectId + "/generate";
      case "generating":
      case "generation_failed":
      case "concepts_ready":
        return project.activeGenerationSetId
          ? "/projects/" + project.projectId + "/generations/" + project.activeGenerationSetId
          : "/projects/" + project.projectId + "/generate";
    }
  })();

  if (requested === "geometry" && project.status !== "brief_confirmed" && !["generating", "generation_failed", "concepts_ready"].includes(project.status)) {
    return null;
  }
  if (requested === "s2" && project.status === "concepts_ready") return null;
  if (
    requested === "brief" &&
    ["geometry_ready", "extracting", "brief_extraction_failed"].includes(project.status)
  ) {
    return null;
  }
  if (requested === "review" && project.status === "brief_review") return null;
  if (requested === "generate" && project.status === "brief_confirmed") return null;
  if (
    requested === "generation" &&
    ["generating", "generation_failed", "concepts_ready"].includes(project.status) &&
    project.activeGenerationSetId === generationSetId
  ) {
    return null;
  }
  return current;
}

export class WorkflowService {
  readonly repository: JsonRepository;
  readonly objects: PrivateObjectStore;
  readonly provider: OpenAIProviderContract;
  readonly s2: S2WorkflowService;
  readonly s3: S3WorkflowService;
  readonly s4: S4WorkflowService;
  private readonly clock: () => string;
  private readonly uuid: () => UUID;
  private readonly workerId: string;
  private readonly processId: number;
  private readonly isProcessAlive: (processId: number) => boolean;
  private readonly inFlight = new Set<string>();

  constructor(options: WorkflowServiceOptions = {}) {
    const root = options.dataRoot ?? defaultDataRoot();
    this.repository = options.repository ?? new JsonRepository(root, {
      processId: options.processId,
      isProcessAlive: options.isProcessAlive,
    });
    this.objects = options.objects ?? new PrivateObjectStore(root + "/objects");
    this.provider = options.provider ?? new OpenAIProvider();
    this.clock = options.clock ?? nowUtc;
    this.uuid = options.uuid ?? newUuid;
    this.processId = options.processId ?? process.pid;
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.workerId = options.workerId ?? `process-${this.processId}-${newUuid()}`;
    this.recoverPendingOperations();
    this.s2 = new S2WorkflowService({
      repository: this.repository,
      objects: this.objects,
      provider: this.provider,
      clock: this.clock,
      uuid: this.uuid,
      workerId: this.workerId,
      processId: this.processId,
      isProcessAlive: this.isProcessAlive,
      onProviderDispatchPhase: options.onProviderDispatchPhase,
      onPublicationPhase: options.onPublicationPhase,
    });
    const providerWithS3 = this.provider as unknown as S3ProviderContract;
    const s3Provider = options.s3Provider ?? (
      typeof providerWithS3.runS3ImageEdit === "function" && typeof providerWithS3.runS3Assessment === "function"
        ? providerWithS3
        : undefined
    );
    this.s3 = new S3WorkflowService({
      repository: this.repository,
      objects: this.objects,
      provider: s3Provider,
      clock: this.clock,
      uuid: this.uuid,
      workerId: this.workerId,
      processId: this.processId,
      isProcessAlive: this.isProcessAlive,
      onProviderDispatchPhase: options.onS3ProviderDispatchPhase,
      onPublicationPhase: options.onS3PublicationPhase,
    });
    this.s4 = new S4WorkflowService({
      repository: this.repository,
      objects: this.objects,
      provider: options.s4Provider,
      clock: this.clock,
      uuid: this.uuid,
      workerId: this.workerId,
      processId: this.processId,
      isProcessAlive: this.isProcessAlive,
      onProviderDispatchPhase: options.onS4ProviderDispatchPhase,
      onPublicationPhase: options.onS4PublicationPhase,
    });
  }

  private state(): StoreState {
    return this.repository.state();
  }

  private projectIn(state: StoreState, projectId: UUID): Project {
    const project = state.projects.find((item) => item.projectId === projectId);
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND");
    return project;
  }

  private assetIn(state: StoreState, assetId: UUID): BriefAsset {
    const asset = state.briefAssets.find((item) => item.assetId === assetId);
    if (!asset) throw new AppError(404, "ASSET_NOT_FOUND");
    return asset;
  }

  private draftIn(state: StoreState, draftId: UUID): StructuredBriefDraft {
    const draft = state.drafts.find((item) => item.briefDraftId === draftId);
    if (!draft) throw new AppError(404, "BRIEF_DRAFT_NOT_FOUND");
    return draft;
  }

  private versionIn(state: StoreState, versionId: UUID): StructuredBriefVersion {
    const version = state.briefVersions.find((item) => item.briefVersionId === versionId);
    if (!version) throw new AppError(404, "BRIEF_VERSION_NOT_FOUND");
    return version;
  }

  private generationSetIn(state: StoreState, generationSetId: UUID): GenerationSet {
    const generationSet = state.generationSets.find((item) => item.generationSetId === generationSetId);
    if (!generationSet) throw new AppError(404, "GENERATION_SET_NOT_FOUND");
    return generationSet;
  }

  private claimIsLive(operation: {
    status: string;
    claimedProcessId: number | null;
  }): boolean {
    if (operation.status !== "running") return false;
    // An incomplete legacy claim cannot prove that its owner is dead. Hold it
    // until an operator or a migration supplies a verifiable process identity.
    if (operation.claimedProcessId === null) return true;
    try {
      return this.isProcessAlive(operation.claimedProcessId);
    } catch {
      return true;
    }
  }

  private clearClaim(operation: {
    claimedBy: string | null;
    claimedProcessId: number | null;
    claimToken: UUID | null;
    claimedAt: string | null;
  }): void {
    operation.claimedBy = null;
    operation.claimedProcessId = null;
    operation.claimToken = null;
    operation.claimedAt = null;
  }

  private claimMatches(
    operation: {
      status: string;
      claimedBy: string | null;
      claimedProcessId: number | null;
      claimToken: UUID | null;
    },
    claimToken: UUID,
  ): boolean {
    return operation.status === "running" &&
      operation.claimedBy === this.workerId &&
      operation.claimedProcessId === this.processId &&
      operation.claimToken === claimToken;
  }

  private idempotencyIn(
    state: StoreState,
    key: UUID,
    operation: string,
    projectId: UUID,
    inputHash: Sha256,
  ): IdempotencyRecord | null {
    const existing = state.idempotency.find((item) => item.key === key);
    if (!existing) return null;
    if (existing.operation !== operation || existing.projectId !== projectId || existing.inputHash !== inputHash) {
      throw new AppError(409, "IDEMPOTENCY_KEY_REUSE");
    }
    return existing;
  }

  private rememberIdempotency(
    state: StoreState,
    key: UUID,
    operation: string,
    projectId: UUID,
    inputHash: Sha256,
    result: Record<string, unknown>,
  ): void {
    state.idempotency.push({
      key,
      operation,
      projectId,
      inputHash,
      result: safeResult(result),
      createdAt: this.clock(),
    });
  }

  private recoverPendingOperations(): void {
    const starts = this.repository.transact((state) => {
      const extractionRequestIds: UUID[] = [];
      const generationSetIds: UUID[] = [];

      for (const operation of state.extractionOperations) {
        if (!pendingOperation(operation.status)) continue;
        if (operation.status === "running" && this.claimIsLive(operation)) continue;
        operation.status = "queued";
        this.clearClaim(operation);
        operation.startedAt = null;
        extractionRequestIds.push(operation.extractionRequestId);
      }

      for (const project of state.projects) {
        if (project.status !== "extracting" || !project.briefAssetId) continue;
        const hasPending = state.extractionOperations.some(
          (operation) => operation.projectId === project.projectId &&
            operation.assetId === project.briefAssetId &&
            pendingOperation(operation.status),
        );
        if (hasPending) continue;
        const attempts = state.extractionAttempts[project.briefAssetId] ?? 1;
        if (attempts >= 2) {
          project.status = "brief_extraction_failed";
          project.updatedAt = this.clock();
          continue;
        }
        const operation: ExtractionOperation = {
          extractionRequestId: this.uuid(),
          projectId: project.projectId,
          assetId: project.briefAssetId,
          attempt: attempts === 2 ? 2 : 1,
          referenceId: this.uuid(),
          status: "queued",
          claimedBy: null,
          claimedProcessId: null,
          claimToken: null,
          claimedAt: null,
          createdAt: this.clock(),
          startedAt: null,
          completedAt: null,
          failureCode: null,
        };
        state.extractionOperations.push(operation);
        extractionRequestIds.push(operation.extractionRequestId);
      }

      for (const operation of state.generationOperations) {
        if (!pendingOperation(operation.status)) continue;
        if (operation.status === "running" && this.claimIsLive(operation)) continue;
        operation.status = "queued";
        this.clearClaim(operation);
        operation.startedAt = null;
        generationSetIds.push(operation.generationSetId);
      }

      for (const generationSet of state.generationSets) {
        if (!pendingOperation(generationSet.status)) continue;
        const hasOperation = state.generationOperations.some(
          (operation) => operation.generationSetId === generationSet.generationSetId,
        );
        if (hasOperation) continue;
        const operation: GenerationOperation = {
          generationSetId: generationSet.generationSetId,
          projectId: generationSet.projectId,
          attempt: generationSet.attempt,
          status: "queued",
          claimedBy: null,
          claimedProcessId: null,
          claimToken: null,
          claimedAt: null,
          createdAt: generationSet.createdAt,
          startedAt: null,
          completedAt: null,
          failureCode: null,
        };
        state.generationOperations.push(operation);
        generationSetIds.push(generationSet.generationSetId);
      }

      return { extractionRequestIds, generationSetIds };
    });

    for (const extractionRequestId of starts.extractionRequestIds) {
      this.startExtraction(extractionRequestId);
    }
    for (const generationSetId of starts.generationSetIds) {
      this.startGeneration(generationSetId);
    }
  }

  getProject(projectId: UUID): Project {
    return cloneJson(this.projectIn(this.state(), projectId));
  }

  getBriefState(projectId: UUID): PublicBriefState {
    const state = this.state();
    const project = this.projectIn(state, projectId);
    const asset = project.briefAssetId ? this.assetIn(state, project.briefAssetId) : null;
    const operation = asset
      ? state.extractionOperations
        .filter((item) => item.assetId === asset.assetId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
      : undefined;
    const extractionAttempts = asset ? state.extractionAttempts[asset.assetId] ?? 0 : 0;
    return {
      project: cloneJson(project),
      asset: asset
        ? {
          assetId: asset.assetId,
          originalFileName: asset.originalFileName,
          byteSize: asset.byteSize,
          pageCount: asset.pageCount,
          status: asset.status,
        }
        : null,
      extractionStatus: operation?.status ?? null,
      extractionRetryEligible: project.status === "brief_extraction_failed" && extractionAttempts < 2,
    };
  }

  createProject(name: unknown): Project {
    if (name !== null && typeof name !== "string") {
      throw new AppError(400, "INVALID_REQUEST", [{ field: "name", code: "STRING_OR_NULL_REQUIRED" }]);
    }
    const normalized = typeof name === "string" ? name.trim() : "";
    const value = normalized || "Untitled project";
    if (Array.from(value).length < 1 || Array.from(value).length > 120) {
      throw new AppError(400, "INVALID_REQUEST", [{ field: "name", code: "NAME_LENGTH" }]);
    }
    const timestamp = this.clock();
    const project = this.repository.transact((state) => {
      const created: Project = {
        projectId: this.uuid(),
        name: value,
        status: "draft",
        boothGeometry: null,
        briefAssetId: null,
        briefDraftId: null,
        confirmedBriefVersionId: null,
        activeGenerationSetId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.projects.push(created);
      return created;
    });
    return cloneJson(project);
  }

  saveGeometry(projectId: UUID, input: unknown): Project {
    const project = this.repository.transact((state) => {
      const current = this.projectIn(state, projectId);
      if (current.confirmedBriefVersionId || ["generating", "generation_failed", "concepts_ready"].includes(current.status)) {
        throw new AppError(409, "GEOMETRY_FROZEN");
      }
      const geometry = validateGeometry(input);
      current.boothGeometry = geometry;
      const hasDraft = Boolean(current.briefDraftId);
      const extracting = state.extractionOperations.some(
        (operation) => operation.projectId === projectId && pendingOperation(operation.status),
      );
      const extractionFailed = current.status === "brief_extraction_failed" && Boolean(current.briefAssetId);
      current.status = hasDraft ? "brief_review" : extractionFailed ? "brief_extraction_failed" : extracting ? "extracting" : "geometry_ready";
      current.updatedAt = this.clock();
      return current;
    });
    return cloneJson(project);
  }

  async uploadBrief(projectId: UUID, key: unknown, input: PdfUpload, referenceId: UUID): Promise<UploadResult> {
    assertUuid(key, "idempotencyKey");
    const validated = await validatePdfUpload(input);
    const inputHash = operationInputHash("brief_upload", projectId, {
      fileSha256: validated.sha256,
      byteSize: validated.byteSize,
    });
    const assetId = this.uuid();
    const storageKey = privateStorageKey("projects", projectId, "briefs", assetId + ".pdf");
    this.objects.put(storageKey, input.bytes);

    let committed = false;
    try {
      const result = this.repository.transact((state) => {
        const project = this.projectIn(state, projectId);
        if (!project.boothGeometry || !geometryIsValid(project.boothGeometry)) {
          throw new AppError(409, "GEOMETRY_REQUIRED");
        }
        const existing = this.idempotencyIn(state, key, "brief_upload", projectId, inputHash);
        if (existing) {
          const existingAssetId = String(existing.result.assetId);
          return {
            asset: cloneJson(this.assetIn(state, existingAssetId)),
            project: cloneJson(project),
            extractionRequestId: null as UUID | null,
            created: false,
          };
        }
        if (project.briefAssetId) throw new AppError(409, "BRIEF_ASSET_EXISTS");
        const extractionRequestId = this.uuid();
        const asset: BriefAsset = {
          assetId,
          projectId,
          kind: "brief",
          originalFileName: validated.originalFileName,
          mimeType: "application/pdf",
          byteSize: validated.byteSize,
          pageCount: validated.pageCount,
          storageKey,
          sha256: validated.sha256,
          status: "stored",
          createdAt: this.clock(),
        };
        const operation: ExtractionOperation = {
          extractionRequestId,
          projectId,
          assetId,
          attempt: 1,
          referenceId,
          status: "queued",
          claimedBy: null,
          claimedProcessId: null,
          claimToken: null,
          claimedAt: null,
          createdAt: this.clock(),
          startedAt: null,
          completedAt: null,
          failureCode: null,
        };
        state.briefAssets.push(asset);
        state.extractionAttempts[assetId] = 1;
        state.extractionOperations.push(operation);
        project.briefAssetId = assetId;
        project.status = "extracting";
        project.updatedAt = this.clock();
        this.rememberIdempotency(state, key, "brief_upload", projectId, inputHash, {
          assetId,
          extractionRequestId,
          referenceId,
        });
        return {
          asset: cloneJson(asset),
          project: cloneJson(project),
          extractionRequestId,
          created: true,
        };
      });
      committed = true;
      if (!result.created) this.objects.remove(storageKey);
      if (result.extractionRequestId) this.startExtraction(result.extractionRequestId);
      return result;
    } catch (error) {
      if (!committed) this.objects.remove(storageKey);
      throw error;
    }
  }

  private startExtraction(extractionRequestId: UUID): void {
    const operationKey = "extraction:" + extractionRequestId;
    if (this.inFlight.has(operationKey)) return;
    this.inFlight.add(operationKey);
    void this.runExtraction(extractionRequestId)
      .catch((error) => {
        console.error(JSON.stringify({
          operation: "brief_extraction",
          extractionRequestId,
          code: providerErrorToCode(error),
        }));
      })
      .finally(() => {
        this.inFlight.delete(operationKey);
      });
  }

  private async runExtraction(extractionRequestId: UUID): Promise<void> {
    const claim = this.repository.transact((state) => {
      const operation = state.extractionOperations.find(
        (item) => item.extractionRequestId === extractionRequestId,
      );
      if (!operation || operation.status !== "queued") return null;
      const claimToken = this.uuid();
      operation.status = "running";
      operation.claimedBy = this.workerId;
      operation.claimedProcessId = this.processId;
      operation.claimToken = claimToken;
      operation.claimedAt = this.clock();
      operation.startedAt = this.clock();
      return {
        projectId: operation.projectId,
        assetId: operation.assetId,
        claimToken,
      };
    });
    if (!claim) return;

    try {
      const asset = this.assetIn(this.state(), claim.assetId);
      const result = await this.provider.extractBrief(this.objects.read(asset.storageKey));
      const data = normalizeProviderBriefData(result.data);
      assertBriefData(data, { extraction: true });
      this.repository.transact((state) => {
        const operation = state.extractionOperations.find(
          (item) => item.extractionRequestId === extractionRequestId,
        );
        if (!operation || !this.claimMatches(operation, claim.claimToken)) return;
        const project = this.projectIn(state, claim.projectId);
        if (project.briefDraftId) {
          operation.status = "succeeded";
          operation.completedAt = this.clock();
          this.clearClaim(operation);
          return;
        }
        const timestamp = this.clock();
        const draft: StructuredBriefDraft = {
          briefDraftId: this.uuid(),
          projectId: claim.projectId,
          sourceAssetId: claim.assetId,
          extractionRequestId,
          schemaVersion: "brief-v1",
          revision: 1,
          status: "extracted",
          data: cloneJson(data),
          providerMetadata: cloneJson(result.metadata),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        state.drafts.push(draft);
        project.briefDraftId = draft.briefDraftId;
        project.status = "brief_review";
        project.updatedAt = timestamp;
        operation.status = "succeeded";
        operation.completedAt = timestamp;
        operation.failureCode = null;
        this.clearClaim(operation);
      });
    } catch (error) {
      this.failExtraction(extractionRequestId, providerErrorToCode(error), claim.claimToken);
    }
  }

  private failExtraction(extractionRequestId: UUID, failureCode: string, claimToken: UUID): void {
    try {
      const committed = this.repository.transact((state) => {
        const operation = state.extractionOperations.find(
          (item) => item.extractionRequestId === extractionRequestId,
        );
        if (!operation || !this.claimMatches(operation, claimToken)) return false;
        operation.status = "failed";
        operation.failureCode = failureCode;
        operation.completedAt = this.clock();
        this.clearClaim(operation);
        const project = this.projectIn(state, operation.projectId);
        if (!project.briefDraftId && project.briefAssetId === operation.assetId) {
          project.status = "brief_extraction_failed";
          project.updatedAt = operation.completedAt;
        }
        console.error(JSON.stringify({
          referenceId: operation.referenceId,
          operation: "brief_extraction",
          projectId: operation.projectId,
          assetId: operation.assetId,
          code: failureCode,
        }));
        return true;
      });
      if (!committed) return;
    } catch {
      console.error(JSON.stringify({
        operation: "brief_extraction",
        extractionRequestId,
        code: "PERSISTENCE_FAILED",
      }));
    }
  }

  retryExtraction(projectId: UUID, assetId: unknown, key: unknown, referenceId: UUID): UploadResult {
    assertUuid(assetId, "assetId");
    assertUuid(key, "idempotencyKey");
    const result = this.repository.transact((state) => {
      const project = this.projectIn(state, projectId);
      const asset = this.assetIn(state, assetId);
      if (asset.projectId !== projectId || project.briefAssetId !== assetId) {
        throw new AppError(404, "ASSET_NOT_FOUND");
      }
      const inputHash = operationInputHash("extraction_retry", projectId, { assetId });
      const existing = this.idempotencyIn(state, key, "extraction_retry", projectId, inputHash);
      if (existing) {
        return {
          asset: cloneJson(asset),
          project: cloneJson(project),
          extractionRequestId: null as UUID | null,
        };
      }
      const attempts = state.extractionAttempts[assetId] ?? 0;
      if (project.status !== "brief_extraction_failed" || attempts >= 2) {
        throw new AppError(409, "RETRY_NOT_ALLOWED");
      }
      const extractionRequestId = this.uuid();
      const operation: ExtractionOperation = {
        extractionRequestId,
        projectId,
        assetId,
        attempt: 2,
        referenceId,
        status: "queued",
        claimedBy: null,
        claimedProcessId: null,
        claimToken: null,
        claimedAt: null,
        createdAt: this.clock(),
        startedAt: null,
        completedAt: null,
        failureCode: null,
      };
      state.extractionAttempts[assetId] = attempts + 1;
      state.extractionOperations.push(operation);
      project.status = "extracting";
      project.updatedAt = this.clock();
      this.rememberIdempotency(state, key, "extraction_retry", projectId, inputHash, {
        assetId,
        extractionRequestId,
        referenceId,
      });
      return { asset: cloneJson(asset), project: cloneJson(project), extractionRequestId };
    });
    if (result.extractionRequestId) this.startExtraction(result.extractionRequestId);
    return result;
  }

  getDraft(projectId: UUID): StructuredBriefDraft {
    const state = this.state();
    const project = this.projectIn(state, projectId);
    if (!project.briefDraftId) {
      if (project.status === "brief_extraction_failed") throw new AppError(502, "EXTRACTION_FAILED");
      throw new AppError(409, "BRIEF_DRAFT_NOT_READY");
    }
    return cloneJson(this.draftIn(state, project.briefDraftId));
  }

  editDraft(projectId: UUID, data: unknown, expectedRevision: unknown): StructuredBriefDraft {
    const draft = this.repository.transact((state) => {
      const project = this.projectIn(state, projectId);
      if (project.status !== "brief_review" || !project.briefDraftId) {
        throw new AppError(409, "BRIEF_REVIEW_REQUIRED");
      }
      const current = this.draftIn(state, project.briefDraftId);
      if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision)) {
        throw new AppError(400, "INVALID_REQUEST", [{ field: "expectedRevision", code: "INTEGER_REQUIRED" }]);
      }
      if (current.revision !== expectedRevision) throw new AppError(409, "DRAFT_REVISION_CONFLICT");
      assertBriefData(data);
      current.data = cloneJson(data);
      current.revision += 1;
      current.status = "edited";
      current.updatedAt = this.clock();
      return current;
    });
    return cloneJson(draft);
  }

  private confirmationAllowed(data: StructuredBriefData): boolean {
    const unknownsReady = data.unknowns.every(
      (item) => !item.critical || Boolean(item.resolution?.trim()) || item.acceptedByUser,
    );
    const assumptionsReady = data.assumptions.every(
      (item) => !item.requiresConfirmation || item.acceptedByUser || item.source === "user",
    );
    return unknownsReady && assumptionsReady;
  }

  confirmBrief(
    projectId: UUID,
    draftId: unknown,
    expectedRevision: unknown,
    key: unknown,
    referenceId: UUID,
  ): StructuredBriefVersion {
    assertUuid(draftId, "draftId");
    assertUuid(key, "idempotencyKey");
    const version = this.repository.transact((state) => {
      const project = this.projectIn(state, projectId);
      const draft = this.draftIn(state, draftId);
      const inputHash = operationInputHash("brief_confirm", projectId, {
        draftId,
        expectedRevision,
        dataHash: sha256(jcs(draft.data)),
      });
      const existing = this.idempotencyIn(state, key, "brief_confirm", projectId, inputHash);
      if (existing) return cloneJson(this.versionIn(state, String(existing.result.briefVersionId)));
      if (project.status !== "brief_review" || project.briefDraftId !== draftId) {
        throw new AppError(409, "BRIEF_CONFIRMATION_NOT_ALLOWED");
      }
      if (
        typeof expectedRevision !== "number" ||
        !Number.isInteger(expectedRevision) ||
        draft.revision !== expectedRevision
      ) {
        throw new AppError(409, "DRAFT_REVISION_CONFLICT");
      }
      if (!project.boothGeometry || !geometryIsValid(project.boothGeometry)) {
        throw new AppError(409, "GEOMETRY_REQUIRED");
      }
      if (!this.confirmationAllowed(draft.data)) throw new AppError(409, "CONFIRMATION_REQUIRED");
      if (project.confirmedBriefVersionId) throw new AppError(409, "BRIEF_ALREADY_CONFIRMED");
      const timestamp = this.clock();
      const geometrySnapshot = cloneJson(project.boothGeometry);
      const version: StructuredBriefVersion = {
        briefVersionId: this.uuid(),
        projectId,
        sourceDraftId: draftId,
        sourceAssetId: draft.sourceAssetId,
        versionNumber: 1,
        schemaVersion: "brief-v1",
        status: "confirmed",
        geometrySnapshot,
        data: cloneJson(draft.data),
        contentHash: sha256(jcs({ schemaVersion: "brief-v1", geometrySnapshot, data: draft.data })),
        confirmationMode: "explicit_user_action",
        confirmedAt: timestamp,
        extractionProviderMetadata: cloneJson(draft.providerMetadata),
      };
      state.briefVersions.push(version);
      project.confirmedBriefVersionId = version.briefVersionId;
      project.status = "brief_confirmed";
      project.updatedAt = timestamp;
      this.rememberIdempotency(state, key, "brief_confirm", projectId, inputHash, {
        briefVersionId: version.briefVersionId,
        referenceId,
      });
      return version;
    });
    return cloneJson(version);
  }

  private confirmedBrief(version: StructuredBriefVersion): UserConfirmedBrief {
    return {
      briefVersionId: version.briefVersionId,
      projectId: version.projectId,
      versionNumber: version.versionNumber,
      sourceAssetId: version.sourceAssetId,
      schemaVersion: version.schemaVersion,
      geometrySnapshot: cloneJson(version.geometrySnapshot),
      data: cloneJson(version.data),
      contentHash: version.contentHash,
      confirmedAt: version.confirmedAt,
    };
  }

  private createGenerationSetInState(
    state: StoreState,
    project: Project,
    version: StructuredBriefVersion,
    attempt: 1 | 2,
    retryOfGenerationSetId: UUID | null,
    key: UUID,
    referenceId: UUID,
    compilerInputHashValue: Sha256,
    idempotencyInputHash: Sha256,
  ): GenerationSet {
    const setId = this.uuid();
    const requestId = this.uuid();
    const confirmed = this.confirmedBrief(version);
    const compiledAt = this.clock();
    const promptRecords = DIRECTIONS.map((direction) => {
      const compiled = compilePrompt(confirmed, direction, compiledAt);
      return {
        compiledPromptId: this.uuid(),
        generationSetId: setId,
        candidateIndex: direction.candidateIndex,
        directionKey: direction.key,
        compilerMetadata: compiled.compilerMetadata,
        promptText: compiled.promptText,
        createdAt: compiledAt,
      };
    });
    const set: GenerationSet = {
      generationSetId: setId,
      projectId: project.projectId,
      confirmedBriefVersionId: version.briefVersionId,
      generationRequestId: requestId,
      attempt,
      retryOfGenerationSetId,
      status: "queued",
      expectedCandidateCount: 4,
      promptCompilerVersion: COMPILER_VERSION,
      promptManifestHash: promptManifestHash(promptRecords.map((item) => item.compilerMetadata.promptHash)),
      provider: "openai",
      imageModelSnapshot: IMAGE_MODEL_SNAPSHOT,
      createdAt: compiledAt,
      completedAt: null,
      failureCode: null,
    };
    const request: GenerationRequest = {
      generationRequestId: requestId,
      projectId: project.projectId,
      confirmedBriefVersionId: version.briefVersionId,
      generationSetId: setId,
      idempotencyKey: key,
      inputHash: compilerInputHashValue,
      requestedCandidateCount: 4,
      attempt,
      status: "accepted",
      requestReferenceId: referenceId,
      failureCode: null,
      createdAt: compiledAt,
      completedAt: null,
    };
    const operation: GenerationOperation = {
      generationSetId: setId,
      projectId: project.projectId,
      attempt,
      status: "queued",
      claimedBy: null,
      claimedProcessId: null,
      claimToken: null,
      claimedAt: null,
      createdAt: compiledAt,
      startedAt: null,
      completedAt: null,
      failureCode: null,
    };
    state.generationRequests.push(request);
    state.generationSets.push(set);
    state.generationOperations.push(operation);
    state.prompts.push(...promptRecords);
    project.activeGenerationSetId = setId;
    project.status = "generating";
    project.updatedAt = compiledAt;
    this.rememberIdempotency(
      state,
      key,
      attempt === 1 ? "generation_create" : "generation_retry",
      project.projectId,
      idempotencyInputHash,
      { generationSetId: setId, referenceId },
    );
    return set;
  }

  createGeneration(projectId: UUID, key: unknown, referenceId: UUID): PublicGeneration {
    assertUuid(key, "idempotencyKey");
    const result = this.repository.transact((state) => {
      const project = this.projectIn(state, projectId);
      if (!project.confirmedBriefVersionId) throw new AppError(409, "BRIEF_CONFIRMATION_REQUIRED");
      const version = this.versionIn(state, project.confirmedBriefVersionId);
      if (!geometryIsValid(version.geometrySnapshot)) throw new AppError(409, "GEOMETRY_INVALID");
      const compilerInputHashValue = compilerInputHash(this.confirmedBrief(version));
      const inputHash = operationInputHash("generation_create", projectId, {
        confirmedBriefVersionId: version.briefVersionId,
        compilerInputHash: compilerInputHashValue,
      });
      const existingIdempotency = this.idempotencyIn(state, key, "generation_create", projectId, inputHash);
      if (existingIdempotency) {
        return { generationSetId: String(existingIdempotency.result.generationSetId), start: false };
      }
      const existingSet = project.activeGenerationSetId
        ? state.generationSets.find((item) => item.generationSetId === project.activeGenerationSetId)
        : state.generationSets
          .filter((item) => item.confirmedBriefVersionId === version.briefVersionId)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (existingSet) {
        this.rememberIdempotency(state, key, "generation_create", projectId, inputHash, {
          generationSetId: existingSet.generationSetId,
          referenceId,
        });
        return { generationSetId: existingSet.generationSetId, start: false };
      }
      const created = this.createGenerationSetInState(
        state,
        project,
        version,
        1,
        null,
        key,
        referenceId,
        compilerInputHashValue,
        inputHash,
      );
      return { generationSetId: created.generationSetId, start: true };
    });
    if (result.start) this.startGeneration(result.generationSetId);
    return this.publicGeneration(result.generationSetId);
  }

  private startGeneration(generationSetId: UUID): void {
    const operationKey = "generation:" + generationSetId;
    if (this.inFlight.has(operationKey)) return;
    this.inFlight.add(operationKey);
    void this.runGeneration(generationSetId)
      .catch((error) => {
        console.error(JSON.stringify({
          operation: "concept_generation",
          generationSetId,
          code: providerErrorToCode(error),
        }));
      })
      .finally(() => {
        this.inFlight.delete(operationKey);
      });
  }

  private async runGeneration(generationSetId: UUID): Promise<void> {
    const claim = this.repository.transact((state) => {
      const operation = state.generationOperations.find((item) => item.generationSetId === generationSetId);
      if (!operation || operation.status !== "queued") return null;
      const set = this.generationSetIn(state, generationSetId);
      const request = state.generationRequests.find((item) => item.generationRequestId === set.generationRequestId);
      if (!request) throw new AppError(500, "PERSISTENCE_FAILED");
      const claimToken = this.uuid();
      operation.status = "running";
      operation.claimedBy = this.workerId;
      operation.claimedProcessId = this.processId;
      operation.claimToken = claimToken;
      operation.claimedAt = this.clock();
      operation.startedAt = this.clock();
      set.status = "running";
      request.status = "running";
      return { projectId: set.projectId, requestReferenceId: request.requestReferenceId, claimToken };
    });
    if (!claim) return;

    const state = this.state();
    const set = this.generationSetIn(state, generationSetId);
    const prompts = state.prompts
      .filter((item) => item.generationSetId === generationSetId)
      .sort((left, right) => left.candidateIndex - right.candidateIndex);
    const results = await Promise.allSettled(prompts.map((prompt) => this.provider.generateImage(prompt.promptText)));
    const staged: {
      candidateId: UUID;
      assetId: UUID;
      prompt: (typeof prompts)[number];
      result: ImageProviderResult;
      stagingKey: string;
      finalKey: string;
    }[] = [];
    let failureCode: string | null = null;

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "rejected") {
        failureCode = failureCode ?? providerErrorToCode(result.reason);
        continue;
      }
      try {
        validatePng(result.value.pngBytes);
        const candidateId = this.uuid();
        const assetId = this.uuid();
        const stagingKey = privateStorageKey("projects", set.projectId, "staging", generationSetId, candidateId + ".png");
        const finalKey = privateStorageKey("projects", set.projectId, "concepts", candidateId + ".png");
        this.objects.put(stagingKey, result.value.pngBytes);
        staged.push({
          candidateId,
          assetId,
          prompt: prompts[index],
          result: result.value,
          stagingKey,
          finalKey,
        });
      } catch (error) {
        failureCode = failureCode ?? providerErrorToCode(error);
      }
    }

    if (results.length !== 4 || staged.length !== 4 || failureCode) {
      for (const item of staged) this.objects.remove(item.stagingKey);
      this.failGeneration(generationSetId, failureCode ?? "IMAGE_GENERATION_FAILED", claim.claimToken);
      return;
    }

    const conceptAssets: ConceptAsset[] = [];
    const candidates: ConceptCandidate[] = [];
    const promoted: string[] = [];
    try {
      for (const item of staged) {
        this.objects.promote(item.stagingKey, item.finalKey);
        promoted.push(item.finalKey);
        conceptAssets.push({
          assetId: item.assetId,
          projectId: set.projectId,
          generationSetId,
          storageKey: item.finalKey,
          mimeType: "image/png",
          byteSize: item.result.pngBytes.byteLength,
          sha256: sha256(item.result.pngBytes),
          status: "stored",
          createdAt: this.clock(),
        });
        candidates.push({
          candidateId: item.candidateId,
          generationSetId,
          projectId: set.projectId,
          confirmedBriefVersionId: set.confirmedBriefVersionId,
          candidateIndex: item.prompt.candidateIndex,
          directionKey: item.prompt.directionKey,
          assetId: item.assetId,
          compilerMetadata: cloneJson(item.prompt.compilerMetadata),
          providerMetadata: cloneJson(item.result.metadata),
          createdAt: this.clock(),
        });
      }
      if (candidates.length !== 4 || conceptAssets.length !== 4) {
        throw new AppError(500, "PERSISTENCE_FAILED");
      }

      const committed = this.repository.transact((current) => {
        const operation = current.generationOperations.find((item) => item.generationSetId === generationSetId);
        if (!operation || !this.claimMatches(operation, claim.claimToken)) return false;
        if (current.candidates.some((item) => item.generationSetId === generationSetId)) {
          throw new AppError(500, "PERSISTENCE_FAILED");
        }
        const currentSet = this.generationSetIn(current, generationSetId);
        const request = current.generationRequests.find((item) => item.generationRequestId === currentSet.generationRequestId);
        if (!request) throw new AppError(500, "PERSISTENCE_FAILED");
        current.conceptAssets.push(...conceptAssets);
        current.candidates.push(...candidates);
        const completedAt = this.clock();
        currentSet.status = "succeeded";
        currentSet.completedAt = completedAt;
        currentSet.failureCode = null;
        request.status = "succeeded";
        request.completedAt = completedAt;
        request.failureCode = null;
        operation.status = "succeeded";
        operation.completedAt = completedAt;
        operation.failureCode = null;
        this.clearClaim(operation);
        const project = this.projectIn(current, currentSet.projectId);
        project.status = "concepts_ready";
        project.activeGenerationSetId = generationSetId;
        project.updatedAt = completedAt;
        return true;
      });
      if (!committed) {
        for (const item of promoted) this.objects.remove(item);
        return;
      }
    } catch (error) {
      for (const item of promoted) this.objects.remove(item);
      for (const item of staged) this.objects.remove(item.stagingKey);
      this.failGeneration(generationSetId, providerErrorToCode(error), claim.claimToken);
    }
  }

  private failGeneration(generationSetId: UUID, failureCode: string, claimToken: UUID): void {
    try {
      this.repository.transact((state) => {
        const operation = state.generationOperations.find((item) => item.generationSetId === generationSetId);
        if (!operation || !this.claimMatches(operation, claimToken)) return;
        const set = this.generationSetIn(state, generationSetId);
        const request = state.generationRequests.find((item) => item.generationRequestId === set.generationRequestId);
        if (!request) throw new AppError(500, "PERSISTENCE_FAILED");
        const completedAt = this.clock();
        set.status = "failed";
        set.failureCode = failureCode;
        set.completedAt = completedAt;
        request.status = "failed";
        request.failureCode = failureCode;
        request.completedAt = completedAt;
        operation.status = "failed";
        operation.failureCode = failureCode;
        operation.completedAt = completedAt;
        this.clearClaim(operation);
        const project = this.projectIn(state, set.projectId);
        project.status = "generation_failed";
        project.activeGenerationSetId = set.generationSetId;
        project.updatedAt = completedAt;
        console.error(JSON.stringify({
          referenceId: request.requestReferenceId,
          operation: "concept_generation",
          projectId: set.projectId,
          generationSetId,
          code: failureCode,
        }));
      });
    } catch {
      console.error(JSON.stringify({
        operation: "concept_generation",
        generationSetId,
        code: "PERSISTENCE_FAILED",
      }));
    }
  }

  retryGeneration(projectId: UUID, generationSetId: UUID, key: unknown, referenceId: UUID): PublicGeneration {
    assertUuid(key, "idempotencyKey");
    const result = this.repository.transact((state) => {
      const project = this.projectIn(state, projectId);
      const failed = this.generationSetIn(state, generationSetId);
      if (failed.projectId !== projectId || failed.status !== "failed" || failed.attempt !== 1) {
        throw new AppError(409, "RETRY_NOT_ALLOWED");
      }
      const inputVersion = this.versionIn(state, failed.confirmedBriefVersionId);
      const compilerInputHashValue = compilerInputHash(this.confirmedBrief(inputVersion));
      const inputHash = operationInputHash("generation_retry", projectId, {
        generationSetId,
        confirmedBriefVersionId: failed.confirmedBriefVersionId,
        compilerInputHash: compilerInputHashValue,
      });
      const existingIdempotency = this.idempotencyIn(state, key, "generation_retry", projectId, inputHash);
      if (existingIdempotency) return { generationSetId: String(existingIdempotency.result.generationSetId), start: false };
      if (state.generationSets.some((item) => item.retryOfGenerationSetId === generationSetId)) {
        throw new AppError(409, "RETRY_NOT_ALLOWED");
      }
      const retrySet = this.createGenerationSetInState(
        state,
        project,
        inputVersion,
        2,
        generationSetId,
        key,
        referenceId,
        compilerInputHashValue,
        inputHash,
      );
      return { generationSetId: retrySet.generationSetId, start: true };
    });
    if (result.start) this.startGeneration(result.generationSetId);
    return this.publicGeneration(result.generationSetId);
  }

  getGeneration(projectId: UUID, generationSetId: UUID): PublicGeneration {
    const state = this.state();
    const project = this.projectIn(state, projectId);
    const set = this.generationSetIn(state, generationSetId);
    if (set.projectId !== projectId) throw new AppError(404, "GENERATION_SET_NOT_FOUND");
    return this.publicGenerationFromState(state, set.generationSetId);
  }

  private publicGeneration(generationSetId: UUID): PublicGeneration {
    const state = this.state();
    return this.publicGenerationFromState(state, generationSetId);
  }

  private publicGenerationFromState(state: StoreState, generationSetId: UUID): PublicGeneration {
    const set = this.generationSetIn(state, generationSetId);
    const candidates = set.status === "succeeded"
      ? state.candidates
        .filter((item) => item.generationSetId === generationSetId)
        .sort((left, right) => left.candidateIndex - right.candidateIndex)
        .map((item) => cloneJson(item))
      : [];
    if (set.status === "succeeded" && candidates.length !== set.expectedCandidateCount) {
      throw new AppError(500, "PERSISTENCE_FAILED");
    }
    const retryEligible = set.status === "failed" &&
      set.attempt === 1 &&
      !state.generationSets.some((item) => item.retryOfGenerationSetId === generationSetId);
    return { generationSet: cloneJson(set), candidates, retryEligible };
  }

  async waitForDraft(projectId: UUID, timeoutMs = 3_000): Promise<StructuredBriefDraft> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const project = this.getProject(projectId);
      if (project.briefDraftId) return this.getDraft(projectId);
      if (project.status === "brief_extraction_failed") throw new AppError(502, "EXTRACTION_FAILED");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new AppError(504, "EXTRACTION_TIMEOUT");
  }

  async waitForGeneration(projectId: UUID, generationSetId: UUID, timeoutMs = 5_000): Promise<PublicGeneration> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = this.getGeneration(projectId, generationSetId);
      if (result.generationSet.status === "succeeded") return result;
      if (result.generationSet.status === "failed") throw new AppError(502, "IMAGE_GENERATION_FAILED");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new AppError(504, "GENERATION_TIMEOUT");
  }
}

export function createWorkflowService(options: WorkflowServiceOptions = {}): WorkflowService {
  return new WorkflowService(options);
}
