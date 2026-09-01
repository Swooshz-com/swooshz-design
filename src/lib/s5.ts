import { AppError, type Project, type S2InputVersion, type S5ApprovalEvent, type S5Artifact, type S5FrozenGenerationContext, type S5LayoutRequirement, type S5LayoutPlan, type S5MutationFence, type StoreState, type UUID } from "./types";
import { geometryIsValid } from "./geometry";
import { JsonRepository, PrivateObjectStore } from "./store";
import { resolveActiveVisualRevision, type ResolvedVisualRevision } from "./revision-resolver";
import { designRuleSnapshotHash } from "./s3-compiler";
import { assertS5ApprovalFence, assertS5Fence, currentS5ApprovalEvent, currentS5Fence, isS5ApprovalLocked, latestS5Event } from "./s5-lock";
import { canonicalPlanBytes, compileConceptLayoutPlan, S5_LAYOUT_RENDERER_VERSION } from "./s5-layout";
import { renderConceptLayoutSvg, S5_SVG_RENDERER_VERSION } from "./s5-svg";
import { loadApprovedNotoSansFont, pdfPageCount, renderConceptPresentationPdf, S5_PDF_RENDERER_VERSION } from "./s5-pdf";
import { assertUuid, cloneJson, jcs, newUuid, nowUtc, privateStorageKey, sha256 } from "./utils";

export type S5PublicationPhaseHook = (phase: string, artifact: S5Artifact) => void;
export class S5PublicationInterruption extends Error { constructor(message = "simulated S5 publication interruption") { super(message); this.name = "S5PublicationInterruption"; } }
export type S5WorkflowServiceOptions = { repository: JsonRepository; objects: PrivateObjectStore; clock?: () => string; uuid?: () => UUID; workerId?: string; processId?: number; isProcessAlive?: (processId: number) => boolean; onPublicationPhase?: S5PublicationPhaseHook };
export type S5PublicApproval = { status: "not_approved" | "approved" | "reopened"; locked: boolean; approvalEventId: UUID | null; approvalId: UUID | null; approvalGeneration: number; eventSequence: number; observedSelectionVersion: number | null; observedActiveRevisionId: UUID | null; observedLineageRootRevisionId: UUID | null };
export type S5PublicArtifact = { artifactId: UUID; artifactGroupId: UUID; kind: S5Artifact["kind"]; status: S5Artifact["status"]; attempt: 1 | 2; completedAt: string | null; terminalAt: string | null; failureCode: string | null; sourceLayoutGroupId: UUID | null; pageCount: number | null };
export type S5PublicState = { projectId: UUID; approval: S5PublicApproval; artifacts: S5PublicArtifact[] };
export type S5PublicLayout = { artifactGroupId: UUID; artifacts: S5PublicArtifact[] };
export type S5Download = { bytes: Buffer; contentType: "image/png" | "application/json" | "image/svg+xml" | "application/pdf"; fileName: string };
export type S5Metric = { availability: "available" | "unavailable"; value: number | null; reason: string | null };
export type S5Telemetry = { approvalToPlanMs: S5Metric; approvalToPdfMs: S5Metric; artifactFailureRate: S5Metric; providerCost: S5Metric };

function fail(status: number, code: string, field = "request"): AppError { return new AppError(status, code, [{ field, code }]); }
function projectIn(state: StoreState, projectId: UUID): Project { const project = state.projects.find((item) => item.projectId === projectId); if (!project) throw fail(404, "PROJECT_NOT_FOUND"); return project; }
function operationInputHash(operation: string, projectId: UUID, input: unknown): string { return sha256(jcs({ operation, projectId, input })); }
function idempotencyIn(state: StoreState, key: UUID, operation: string, projectId: UUID, inputHash: string): Record<string, unknown> | null { const item = state.idempotency.find((candidate) => candidate.key === key && candidate.operation === operation && candidate.projectId === projectId); if (!item) return null; if (item.inputHash !== inputHash) throw fail(409, "S5_IDEMPOTENCY_KEY_REUSE"); return item.result; }
function remember(state: StoreState, key: UUID, operation: string, projectId: UUID, inputHash: string, result: Record<string, unknown>, at: string): void { state.idempotency.push({ key, operation, projectId, inputHash, result: cloneJson(result), createdAt: at }); }
function publicArtifact(artifact: S5Artifact): S5PublicArtifact { return { artifactId: artifact.artifactId, artifactGroupId: artifact.artifactGroupId, kind: artifact.kind, status: artifact.status, attempt: artifact.attempt, completedAt: artifact.completedAt, terminalAt: artifact.terminalAt, failureCode: artifact.failureCode, sourceLayoutGroupId: artifact.sourceLayoutGroupId, pageCount: artifact.pageCount }; }
function publicApproval(state: StoreState, projectId: UUID): S5PublicApproval {
  const latest = latestS5Event(state, projectId); if (!latest) return { status: "not_approved", locked: false, approvalEventId: null, approvalId: null, approvalGeneration: 0, eventSequence: 0, observedSelectionVersion: null, observedActiveRevisionId: null, observedLineageRootRevisionId: null };
  return { status: latest.kind === "approved" ? "approved" : "reopened", locked: latest.kind === "approved", approvalEventId: latest.kind === "approved" ? latest.eventId : null, approvalId: latest.approvalId, approvalGeneration: latest.approvalGeneration, eventSequence: latest.eventSequence, observedSelectionVersion: latest.observedSelectionVersion, observedActiveRevisionId: latest.observedActiveRevisionId, observedLineageRootRevisionId: latest.observedLineageRootRevisionId };
}
function activeRevisionKind(resolved: ResolvedVisualRevision): S5FrozenGenerationContext["activeRevisionKind"] { if (resolved.kind === "s4") return "s4_local_edit"; return resolved.revisionId === resolved.lineageRootRevisionId ? "s3_source" : "s3_refinement"; }
function sourceFor(state: StoreState, projectId: UUID, sourceSnapshotId: UUID): StoreState["s3Sources"][number] { const source = state.s3Sources.find((item) => item.sourceSnapshotId === sourceSnapshotId && item.projectId === projectId); if (!source) throw fail(409, "S5_FINAL_VISUAL_INELIGIBLE"); return source; }
function inputFor(state: StoreState, projectId: UUID, id: UUID): S2InputVersion { const input = state.s2Inputs.find((item) => item.id === id && item.projectId === projectId); if (!input) throw fail(409, "S5_FINAL_VISUAL_INELIGIBLE"); return input; }
function briefFor(state: StoreState, projectId: UUID, id: UUID): StoreState["briefVersions"][number] { const brief = state.briefVersions.find((item) => item.briefVersionId === id && item.projectId === projectId && item.status === "confirmed"); if (!brief) throw fail(409, "S5_FINAL_VISUAL_INELIGIBLE"); return brief; }
function exactActiveAsset(objects: PrivateObjectStore, resolved: ResolvedVisualRevision): void { try { const bytes = objects.read(resolved.storageKey); if (bytes.byteLength !== resolved.byteSize || sha256(bytes) !== resolved.sha256) throw new Error("asset identity"); } catch { throw fail(409, "S5_APPROVED_ASSET_CORRUPT"); } }

function projectFunctionalRequirements(brief: StoreState["briefVersions"][number], input: S2InputVersion): S5LayoutRequirement[] {
  const canonical = input.canonicalRequirements.filter((item) => item.category === "functional" && item.source === "confirmed_brief"); const functional = brief.data.functionalRequirements;
  if (canonical.length !== functional.length) throw fail(409, "S5_LAYOUT_INPUT_INVALID");
  return functional.map((item, index) => {
    const requirementId = `brief.functional.${String(index + 1).padStart(3, "0")}`; const expected = item.countIsExact && item.count !== null ? "exact_count" : "present"; const expectedCount = expected === "exact_count" ? item.count : null; const canonicalItem = canonical[index];
    if (!canonicalItem || canonicalItem.requirementId !== requirementId || canonicalItem.expectedValue !== item.name || canonicalItem.expected !== expected || canonicalItem.expectedCount !== expectedCount || canonicalItem.text !== (item.details ? `${item.name}: ${item.details}` : item.name)) throw fail(409, "S5_LAYOUT_INPUT_INVALID", `requirements[${index}]`);
    return { requirementId: requirementId as S5LayoutRequirement["requirementId"], name: item.name, details: item.details, mandatory: item.mandatory, count: item.count, countIsExact: item.countIsExact };
  });
}
function presentationFacts(project: Project, brief: StoreState["briefVersions"][number]): S5FrozenGenerationContext["presentationFacts"] { return { projectName: project.name, clientName: brief.data.projectFacts.clientName, eventName: brief.data.projectFacts.eventName, venueName: brief.data.projectFacts.venueName, eventLocation: brief.data.projectFacts.eventLocation, eventStartDate: brief.data.projectFacts.eventStartDate, eventEndDate: brief.data.projectFacts.eventEndDate }; }
function liveContext(state: StoreState, projectId: UUID, selection: StoreState["s3Selections"][number], resolved: ResolvedVisualRevision, eventId: UUID, approvalGeneration: number, eventSequence: number): S5FrozenGenerationContext {
  const project = projectIn(state, projectId); const source = sourceFor(state, projectId, resolved.sourceSnapshotId); const input = inputFor(state, projectId, source.s2InputVersionId); const brief = briefFor(state, projectId, source.confirmedBriefVersionId);
  if (project.activeGenerationSetId !== selection.generationSetId || selection.activeRevisionId !== resolved.revisionId || selection.lineageRootRevisionId !== resolved.lineageRootRevisionId || source.generationSetId !== selection.generationSetId || source.sourceRootRevisionId !== selection.lineageRootRevisionId || source.confirmedBriefContentHash !== brief.contentHash || input.confirmedBriefVersionId !== brief.briefVersionId || input.confirmedBriefContentHash !== brief.contentHash || input.geometryHash !== source.geometryHash || input.requirementHash !== source.requirementHash || jcs(input.canonicalRequirements) !== jcs(source.canonicalRequirements) || jcs(input.designRuleSnapshot) !== jcs(source.designRuleSnapshot) || designRuleSnapshotHash(input.designRuleSnapshot) !== source.designRuleSnapshotHash || sha256(jcs({ schemaVersion: "s2-requirements-v1", requirements: input.canonicalRequirements })) !== input.requirementHash || sha256(jcs(input.geometrySnapshot)) !== input.geometryHash || sha256(jcs({ schemaVersion: "brief-v1", geometrySnapshot: brief.geometrySnapshot, data: brief.data })) !== brief.contentHash || !geometryIsValid(input.geometrySnapshot)) throw fail(409, "S5_FROZEN_CONTEXT_MISMATCH");
  const layoutRequirements = projectFunctionalRequirements(brief, input); const facts = presentationFacts(project, brief);
  return { schemaVersion: "s5-generation-context-v1", projectId, generationSetId: selection.generationSetId, selectionStateId: selection.selectionStateId, selectionVersion: selection.selectionVersion, approvalEventId: eventId, approvalGeneration, eventSequence, activeRevisionId: resolved.revisionId, activeRevisionKind: activeRevisionKind(resolved), sourceSnapshotId: resolved.sourceSnapshotId, lineageRootRevisionId: resolved.lineageRootRevisionId, sourceBindingHash: source.sourceBindingHash, quality: resolved.quality, activeAssetId: resolved.assetId, activeAssetStorageKey: resolved.storageKey, activeAssetSha256: resolved.sha256, activeAssetByteSize: resolved.byteSize, activeAssetWidth: 1536, activeAssetHeight: 1024, activeAssetPixelCount: 1_572_864, confirmedBriefVersionId: brief.briefVersionId, briefContentHash: brief.contentHash, geometrySnapshot: cloneJson(input.geometrySnapshot), geometryHash: input.geometryHash, canonicalRequirements: cloneJson(input.canonicalRequirements), requirementHash: input.requirementHash, layoutRequirements: cloneJson(layoutRequirements), layoutRequirementsHash: sha256(jcs(layoutRequirements)), designRulesVersion: "s2-design-rules-v1", designRuleSnapshot: cloneJson(input.designRuleSnapshot), designRuleSnapshotHash: designRuleSnapshotHash(input.designRuleSnapshot), presentationFacts: cloneJson(facts), presentationFactsHash: sha256(jcs(facts)), layoutRendererVersion: S5_LAYOUT_RENDERER_VERSION, svgRendererVersion: S5_SVG_RENDERER_VERSION, pdfRendererVersion: S5_PDF_RENDERER_VERSION };
}
export function generationContextHash(context: S5FrozenGenerationContext): string { return sha256(jcs(context)); }
function assertFrozenContextCurrent(state: StoreState, projectId: UUID, approval: S5ApprovalEvent, objects: PrivateObjectStore): S5FrozenGenerationContext {
  if (approval.kind !== "approved" || approval.generationContext === null || approval.generationContextHash !== generationContextHash(approval.generationContext)) throw fail(409, "S5_FROZEN_CONTEXT_MISMATCH");
  if (currentS5ApprovalEvent(state, projectId)?.eventId !== approval.eventId) throw fail(409, "S5_APPROVAL_STALE");
  const context = cloneJson(approval.generationContext); if (context.projectId !== projectId || context.approvalEventId !== approval.eventId || context.approvalGeneration !== approval.approvalGeneration || context.eventSequence !== approval.eventSequence || context.selectionVersion !== approval.observedSelectionVersion || context.activeRevisionId !== approval.observedActiveRevisionId || context.lineageRootRevisionId !== approval.observedLineageRootRevisionId) throw fail(409, "S5_FROZEN_CONTEXT_MISMATCH");
  const selection = state.s3Selections.find((item) => item.projectId === projectId && item.selectionStateId === approval.selectionStateId); if (!selection || selection.generationSetId !== approval.generationSetId || selection.selectionVersion !== approval.observedSelectionVersion || selection.activeRevisionId !== approval.observedActiveRevisionId || selection.lineageRootRevisionId !== approval.observedLineageRootRevisionId) throw fail(409, "S5_APPROVAL_STALE");
  let resolved: ResolvedVisualRevision | null; try { resolved = resolveActiveVisualRevision(state, projectId, objects); } catch { throw fail(409, "S5_APPROVAL_STALE"); }
  if (!resolved || resolved.revisionId !== context.activeRevisionId || resolved.sourceSnapshotId !== context.sourceSnapshotId || resolved.lineageRootRevisionId !== context.lineageRootRevisionId || resolved.quality !== context.quality || resolved.assetId !== context.activeAssetId || resolved.sha256 !== context.activeAssetSha256 || resolved.byteSize !== context.activeAssetByteSize) throw fail(409, "S5_APPROVAL_STALE");
  exactActiveAsset(objects, resolved);
  const projected = liveContext(state, projectId, selection, resolved, approval.eventId, approval.approvalGeneration, approval.eventSequence);
  if (jcs(projected) !== jcs(context)) throw fail(409, "S5_FROZEN_CONTEXT_MISMATCH");
  return context;
}
export function buildS5FrozenGenerationContext(state: StoreState, projectId: UUID, approval: S5ApprovalEvent, objects: PrivateObjectStore): S5FrozenGenerationContext { return assertFrozenContextCurrent(state, projectId, approval, objects); }
function planFromContext(context: S5FrozenGenerationContext): S5LayoutPlan { return compileConceptLayoutPlan({ projectId: context.projectId, generationSetId: context.generationSetId, selectionStateId: context.selectionStateId, selectionVersion: context.selectionVersion, activeRevisionId: context.activeRevisionId, activeRevisionKind: context.activeRevisionKind, approvalEventId: context.approvalEventId, approvalGeneration: context.approvalGeneration, approvalEventSequence: context.eventSequence, geometry: context.geometrySnapshot, requirements: context.layoutRequirements, canonicalRequirements: context.canonicalRequirements }); }
function rendererFor(kind: S5Artifact["kind"]): S5Artifact["rendererVersion"] { return kind === "plan_json" ? "s5-concept-layout-v1" : kind === "plan_svg" ? "s5-layout-svg-v1" : "s5-presentation-pdf-v1"; }
function mimeFor(kind: S5Artifact["kind"]): S5Artifact["mimeType"] { return kind === "plan_json" ? "application/json" : kind === "plan_svg" ? "image/svg+xml" : "application/pdf"; }
function extensionFor(kind: S5Artifact["kind"]): S5Artifact["fileExtension"] { return kind === "plan_json" ? ".json" : kind === "plan_svg" ? ".svg" : ".pdf"; }
function fileFor(kind: S5Artifact["kind"]): S5Artifact["fileName"] { return kind === "plan_json" ? "swooshz-concept-layout-plan.json" : kind === "plan_svg" ? "swooshz-concept-layout-plan.svg" : "swooshz-concept-presentation.pdf"; }
function artifactKey(context: S5FrozenGenerationContext, kind: S5Artifact["kind"], planHash: string): string { return privateStorageKey("projects", context.projectId, "s5", "artifacts", context.generationSetId, `approval-${context.approvalGeneration}`, generationContextHash(context), planHash, rendererFor(kind), kind); }
function newArtifact(context: S5FrozenGenerationContext, kind: S5Artifact["kind"], groupId: UUID, planHash: string, sourceLayoutGroupId: UUID | null, idempotencyKey: UUID, requestReferenceId: UUID, uuid: () => UUID, clock: () => string, retryOfArtifactId: UUID | null = null, attempt: 1 | 2 = 1): S5Artifact {
  const artifactId = uuid(); const at = clock(); return { schemaVersion: "s5-artifact-v1", artifactId, artifactGroupId: groupId, projectId: context.projectId, generationSetId: context.generationSetId, selectionStateId: context.selectionStateId, selectionVersion: context.selectionVersion, activeRevisionId: context.activeRevisionId, approvalEventId: context.approvalEventId, approvalGeneration: context.approvalGeneration, generationContextHash: generationContextHash(context), planHash: planHash as S5Artifact["planHash"], kind, rendererVersion: rendererFor(kind), mimeType: mimeFor(kind), fileExtension: extensionFor(kind), fileName: fileFor(kind), sourceLayoutGroupId, artifactKey: artifactKey(context, kind, planHash), stagingKey: privateStorageKey("projects", context.projectId, "s5", "staging", artifactId, "pending", kind), outputSha256: null, outputByteSize: null, pageCount: null, attempt, retryOfArtifactId, status: "queued", publicationPhase: "none", workerId: null, processId: null, claimToken: null, claimedAt: null, startedAt: null, stagedAt: null, promotedAt: null, completedAt: null, terminalAt: null, failureCode: null, idempotencyKey, requestReferenceId, createdAt: at, updatedAt: at };
}
function contentMatches(objects: PrivateObjectStore, key: string, bytes: Uint8Array): boolean { try { const actual = objects.read(key); return actual.byteLength === bytes.byteLength && sha256(actual) === sha256(bytes) && actual.equals(Buffer.from(bytes)); } catch { return false; } }

function currentApprovalOrFail(state: StoreState, projectId: UUID, fence: S5MutationFence): S5ApprovalEvent {
  assertS5Fence(state, projectId, fence);
  const approval = currentS5ApprovalEvent(state, projectId);
  if (!approval) throw fail(409, "S5_APPROVAL_REQUIRED");
  if (approval.eventId !== fence.expectedApprovalEventId) throw fail(409, "S5_APPROVAL_STALE");
  return approval;
}

function publicArtifacts(state: StoreState, projectId: UUID, groupId: UUID): S5PublicArtifact[] {
  return state.s5Artifacts
    .filter((item) => item.projectId === projectId && item.artifactGroupId === groupId)
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.attempt - right.attempt || left.createdAt.localeCompare(right.createdAt))
    .map(publicArtifact);
}

function metricUnavailable(reason: string): S5Metric { return { availability: "unavailable", value: null, reason }; }

function assertFenceInput(fence: S5MutationFence): void {
  assertUuid(fence.expectedGenerationSetId, "expectedGenerationSetId");
  assertUuid(fence.expectedSelectionStateId, "expectedSelectionStateId");
  assertUuid(fence.expectedActiveRevisionId, "expectedActiveRevisionId");
  if (fence.expectedApprovalEventId !== null) assertUuid(fence.expectedApprovalEventId, "expectedApprovalEventId");
  for (const field of ["expectedSelectionVersion", "expectedApprovalGeneration", "expectedApprovalEventSequence"] as const) {
    const value = fence[field];
    if (!Number.isSafeInteger(value) || value < 0) throw fail(400, "INVALID_REQUEST", field);
  }
  if (fence.expectedSelectionVersion < 1) throw fail(400, "INVALID_REQUEST", "expectedSelectionVersion");
}

function committedLayoutGroup(state: StoreState, projectId: UUID, approval: S5ApprovalEvent, planHash: string): UUID | null {
  const groups = new Map<UUID, S5Artifact[]>();
  for (const artifact of state.s5Artifacts) {
    if (artifact.projectId !== projectId || artifact.approvalEventId !== approval.eventId || artifact.planHash !== planHash) continue;
    const values = groups.get(artifact.artifactGroupId) ?? []; values.push(artifact); groups.set(artifact.artifactGroupId, values);
  }
  const candidates = [...groups.entries()].filter(([, values]) => values.some((item) => item.kind === "plan_json" && item.status === "committed") && values.some((item) => item.kind === "plan_svg" && item.status === "committed"));
  candidates.sort((left, right) => Math.max(...right[1].map((item) => Date.parse(item.createdAt))) - Math.max(...left[1].map((item) => Date.parse(item.createdAt))) || left[0].localeCompare(right[0]));
  return candidates[0]?.[0] ?? null;
}

export class S5WorkflowService {
  readonly repository: JsonRepository;
  readonly objects: PrivateObjectStore;
  private readonly clock: () => string;
  private readonly uuid: () => UUID;
  private readonly workerId: string;
  private readonly processId: number;
  private readonly isProcessAlive: (processId: number) => boolean;
  private readonly onPublicationPhase: S5PublicationPhaseHook | undefined;

  constructor(options: S5WorkflowServiceOptions) {
    this.repository = options.repository; this.objects = options.objects; this.clock = options.clock ?? nowUtc; this.uuid = options.uuid ?? newUuid; this.processId = options.processId ?? process.pid; this.workerId = options.workerId ?? `s5-process-${this.processId}`; this.isProcessAlive = options.isProcessAlive ?? ((processId) => { try { process.kill(processId, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } }); this.onPublicationPhase = options.onPublicationPhase; void this.recoverPending().catch(() => undefined);
  }

  getState(projectId: UUID): S5PublicState {
    const state = this.repository.state(); projectIn(state, projectId);
    return { projectId, approval: publicApproval(state, projectId), artifacts: state.s5Artifacts.filter((item) => item.projectId === projectId).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.attempt - right.attempt).map(publicArtifact) };
  }
  getFence(projectId: UUID): S5MutationFence { const state = this.repository.state(); projectIn(state, projectId); return currentS5Fence(state, projectId); }
  getHeroStatus(projectId: UUID): { available: boolean; contentType: "image/png"; fileName: string } {
    const state = this.repository.state(); projectIn(state, projectId); try { const approval = currentS5ApprovalEvent(state, projectId); if (!approval) return { available: false, contentType: "image/png", fileName: "swooshz-approved-hero.png" }; const resolved = resolveActiveVisualRevision(state, projectId, this.objects); if (!resolved) return { available: false, contentType: "image/png", fileName: "swooshz-approved-hero.png" }; exactActiveAsset(this.objects, resolved); return { available: resolved.revisionId === approval.observedActiveRevisionId, contentType: "image/png", fileName: "swooshz-approved-hero.png" }; } catch { return { available: false, contentType: "image/png", fileName: "swooshz-approved-hero.png" }; }
  }

  approve(projectId: UUID, fence: S5MutationFence, key: UUID, requestReferenceId: UUID): { approval: S5PublicApproval; replayed: boolean } {
    assertUuid(key, "Idempotency-Key"); assertUuid(requestReferenceId, "x-request-id"); assertFenceInput(fence); const inputHash = operationInputHash("s5_approve", projectId, fence);
    const result = this.repository.transact((state) => {
      projectIn(state, projectId); const replay = idempotencyIn(state, key, "s5_approve", projectId, inputHash); if (replay) { const event = state.s5ApprovalEvents.find((item) => item.eventId === String(replay.eventId)); if (!event) throw fail(500, "S5_PERSISTENCE_FAILED"); return { event: cloneJson(event), replayed: true }; }
      assertS5Fence(state, projectId, fence); if (isS5ApprovalLocked(state, projectId)) throw fail(409, "S5_APPROVAL_LOCKED"); const selection = state.s3Selections.find((item) => item.projectId === projectId && item.selectionStateId === fence.expectedSelectionStateId); if (!selection || !selection.activeRevisionId || !selection.lineageRootRevisionId) throw fail(409, "S5_FINAL_VISUAL_INELIGIBLE");
      let resolved: ResolvedVisualRevision | null; try { resolved = resolveActiveVisualRevision(state, projectId, this.objects); } catch { throw fail(409, "S5_FINAL_VISUAL_INELIGIBLE"); } if (!resolved || resolved.revisionId !== selection.activeRevisionId) throw fail(409, "S5_FINAL_VISUAL_INELIGIBLE"); const previous = latestS5Event(state, projectId); const eventId = this.uuid(); const approvalGeneration = previous ? previous.approvalGeneration + 1 : 1; const eventSequence = previous ? previous.eventSequence + 1 : 1; const context = liveContext(state, projectId, selection, resolved, eventId, approvalGeneration, eventSequence); const event: S5ApprovalEvent = { schemaVersion: "s5-approval-event-v1", eventId, projectId, generationSetId: selection.generationSetId, selectionStateId: selection.selectionStateId, eventSequence, approvalId: eventId, approvalGeneration, observedSelectionVersion: selection.selectionVersion, observedActiveRevisionId: selection.activeRevisionId, observedLineageRootRevisionId: selection.lineageRootRevisionId, kind: "approved", reopenReason: null, generationContext: context, generationContextHash: generationContextHash(context), idempotencyKey: key, requestReferenceId, occurredAt: this.clock() }; state.s5ApprovalEvents.push(event); remember(state, key, "s5_approve", projectId, inputHash, { eventId }, this.clock()); return { event: cloneJson(event), replayed: false };
    });
    return { approval: publicApproval(this.repository.state(), projectId), replayed: result.replayed };
  }

  private claimArtifact(artifactId: UUID): { artifact: S5Artifact; token: UUID } | null {
    return this.repository.transact((state) => {
      const artifact = state.s5Artifacts.find((item) => item.artifactId === artifactId);
      if (!artifact || artifact.status !== "queued") return null;
      const token = this.uuid(); const at = this.clock(); artifact.status = "running"; artifact.publicationPhase = "none"; artifact.claimToken = token; artifact.workerId = this.workerId; artifact.processId = this.processId; artifact.claimedAt = at; artifact.startedAt = artifact.startedAt ?? at; artifact.stagingKey = privateStorageKey("projects", artifact.projectId, "s5", "staging", artifact.artifactId, token, artifact.kind); artifact.updatedAt = at;
      return { artifact: cloneJson(artifact), token };
    });
  }
  private failArtifact(artifactId: UUID, token: UUID, code: string, aborted = false): void {
    this.repository.transact((state) => { const artifact = state.s5Artifacts.find((item) => item.artifactId === artifactId); if (!artifact || artifact.claimToken !== token || artifact.status === "committed") return; artifact.status = aborted ? "aborted" : artifact.attempt === 1 ? "failed_retryable" : "failed_terminal"; artifact.publicationPhase = "aborted"; artifact.failureCode = code; artifact.terminalAt = this.clock(); artifact.claimToken = null; artifact.workerId = null; artifact.processId = null; artifact.claimedAt = null; artifact.updatedAt = this.clock(); });
  }
  private commitArtifact(artifactId: UUID, token: UUID, bytes: Buffer, pageCount: number | null): boolean {
    return this.repository.transact((state) => {
      const artifact = state.s5Artifacts.find((item) => item.artifactId === artifactId); if (!artifact || artifact.claimToken !== token || artifact.status !== "staged" || artifact.publicationPhase !== "promoted") throw fail(409, "S5_CLAIM_FENCED");
      const approval = currentS5ApprovalEvent(state, artifact.projectId); if (!approval || approval.eventId !== artifact.approvalEventId) { artifact.status = "aborted"; artifact.publicationPhase = "aborted"; artifact.failureCode = "S5_APPROVAL_STALE"; artifact.terminalAt = this.clock(); artifact.claimToken = null; artifact.workerId = null; artifact.processId = null; artifact.claimedAt = null; artifact.updatedAt = this.clock(); return false; }
      try { const context = assertFrozenContextCurrent(state, artifact.projectId, approval, this.objects); if (generationContextHash(context) !== artifact.generationContextHash) throw new Error("context"); const finalBytes = this.objects.read(artifact.artifactKey); if (!contentMatches(this.objects, artifact.artifactKey, bytes) || finalBytes.byteLength !== bytes.byteLength) throw fail(500, "S5_PUBLICATION_MISMATCH"); }
      catch (error) { if (error instanceof AppError && error.code === "S5_APPROVAL_STALE") { artifact.status = "aborted"; artifact.publicationPhase = "aborted"; artifact.failureCode = error.code; artifact.terminalAt = this.clock(); artifact.claimToken = null; artifact.workerId = null; artifact.processId = null; artifact.claimedAt = null; artifact.updatedAt = this.clock(); return false; } throw error; }
      artifact.status = "committed"; artifact.publicationPhase = "committed"; artifact.outputSha256 = sha256(bytes); artifact.outputByteSize = bytes.byteLength; artifact.pageCount = pageCount; artifact.completedAt = this.clock(); artifact.claimToken = null; artifact.workerId = null; artifact.processId = null; artifact.claimedAt = null; artifact.updatedAt = this.clock(); return true;
    });
  }
  private publishClaim(artifactId: UUID, token: UUID, bytes: Buffer, pageCount: number | null): void {
    let artifact = this.repository.state().s5Artifacts.find((item) => item.artifactId === artifactId); if (!artifact || artifact.claimToken !== token) throw fail(409, "S5_CLAIM_FENCED");
    try {
      this.onPublicationPhase?.("claimed", cloneJson(artifact)); this.onPublicationPhase?.("before-staging", cloneJson(artifact));
      if (this.objects.exists(artifact.stagingKey) && !contentMatches(this.objects, artifact.stagingKey, bytes)) throw fail(409, "S5_PUBLICATION_MISMATCH");
      try { this.objects.putExact(artifact.stagingKey, bytes); } catch { if (!contentMatches(this.objects, artifact.stagingKey, bytes)) throw fail(500, "S5_PUBLICATION_UNCERTAIN"); }
      const staged = this.objects.read(artifact.stagingKey); if (!contentMatches(this.objects, artifact.stagingKey, bytes)) throw fail(500, "S5_PUBLICATION_UNCERTAIN");
      artifact = this.repository.transact((state) => { const current = state.s5Artifacts.find((item) => item.artifactId === artifactId); if (!current || current.claimToken !== token) throw fail(409, "S5_CLAIM_FENCED"); current.status = "staged"; current.publicationPhase = "staged"; current.outputSha256 = sha256(staged); current.outputByteSize = staged.byteLength; current.pageCount = pageCount; current.stagedAt = this.clock(); current.updatedAt = this.clock(); return cloneJson(current); }); this.onPublicationPhase?.("after-staging", artifact);
      this.onPublicationPhase?.("before-promotion", artifact); try { this.objects.promoteExact(artifact.stagingKey, artifact.artifactKey, bytes); } catch { if (!contentMatches(this.objects, artifact.artifactKey, bytes)) throw fail(500, "S5_PUBLICATION_MISMATCH"); }
      const promoted = this.objects.read(artifact.artifactKey); if (!contentMatches(this.objects, artifact.artifactKey, bytes)) throw fail(500, "S5_PUBLICATION_UNCERTAIN");
      artifact = this.repository.transact((state) => { const current = state.s5Artifacts.find((item) => item.artifactId === artifactId); if (!current || current.claimToken !== token) throw fail(409, "S5_CLAIM_FENCED"); current.publicationPhase = "promoted"; current.status = "staged"; current.promotedAt = this.clock(); current.updatedAt = this.clock(); return cloneJson(current); }); this.onPublicationPhase?.("after-promotion", artifact); this.onPublicationPhase?.("before-commit", artifact); const committed = this.commitArtifact(artifactId, token, promoted, pageCount); if (committed) { this.onPublicationPhase?.("after-commit", this.repository.state().s5Artifacts.find((item) => item.artifactId === artifactId)!); this.objects.remove(artifact.stagingKey); } else { this.objects.remove(artifact.stagingKey); }
    } catch (error) { if (error instanceof S5PublicationInterruption) throw error; const code = error instanceof AppError ? error.code : "S5_PUBLICATION_UNCERTAIN"; this.failArtifact(artifactId, token, code, code === "S5_APPROVAL_STALE" || code === "S5_CLAIM_FENCED"); }
  }
  private renderSync(artifact: S5Artifact): Buffer {
    const state = this.repository.state(); const approval = state.s5ApprovalEvents.find((item) => item.eventId === artifact.approvalEventId); if (!approval) throw fail(409, "S5_APPROVAL_STALE"); const context = assertFrozenContextCurrent(state, artifact.projectId, approval, this.objects); if (generationContextHash(context) !== artifact.generationContextHash) throw fail(409, "S5_FROZEN_CONTEXT_MISMATCH"); const plan = planFromContext(context); if (plan.planHash !== artifact.planHash) throw fail(409, "S5_PUBLICATION_MISMATCH"); if (artifact.kind === "plan_json") return canonicalPlanBytes(plan); if (artifact.kind === "plan_svg") return renderConceptLayoutSvg(plan); throw fail(500, "S5_RENDER_FAILURE");
  }
  private async renderPdf(artifact: S5Artifact): Promise<{ bytes: Buffer; pageCount: number }> {
    const state = this.repository.state(); const approval = state.s5ApprovalEvents.find((item) => item.eventId === artifact.approvalEventId); if (!approval) throw fail(409, "S5_APPROVAL_STALE"); const context = assertFrozenContextCurrent(state, artifact.projectId, approval, this.objects); if (generationContextHash(context) !== artifact.generationContextHash) throw fail(409, "S5_FROZEN_CONTEXT_MISMATCH"); const plan = planFromContext(context); if (plan.planHash !== artifact.planHash) throw fail(409, "S5_PUBLICATION_MISMATCH"); const bytes = await renderConceptPresentationPdf({ projectName: context.presentationFacts.projectName, projectFacts: context.presentationFacts, geometry: context.geometrySnapshot, quality: context.quality, activeRevisionKind: context.activeRevisionKind, plan, requirements: context.layoutRequirements, designRules: context.designRuleSnapshot, unknowns: plan.unknowns, heroBytes: this.objects.read(context.activeAssetStorageKey), fontBytes: await loadApprovedNotoSansFont() }); return { bytes, pageCount: await pdfPageCount(bytes) };
  }
  private processSync(artifactId: UUID): void {
    const claim = this.claimArtifact(artifactId); if (!claim) return;
    try { this.publishClaim(artifactId, claim.token, this.renderSync(claim.artifact), null); }
    catch (error) { if (error instanceof S5PublicationInterruption) throw error; const code = error instanceof AppError ? error.code : "S5_RENDER_FAILURE"; this.failArtifact(artifactId, claim.token, code, code === "S5_APPROVAL_STALE" || code === "S5_CLAIM_FENCED"); }
  }
  private async processAsync(artifactId: UUID): Promise<void> {
    const claim = this.claimArtifact(artifactId); if (!claim) return;
    try { const output = await this.renderPdf(claim.artifact); this.publishClaim(artifactId, claim.token, output.bytes, output.pageCount); }
    catch (error) { if (error instanceof S5PublicationInterruption) throw error; const code = error instanceof AppError ? error.code : "S5_RENDER_FAILURE"; this.failArtifact(artifactId, claim.token, code, code === "S5_APPROVAL_STALE" || code === "S5_CLAIM_FENCED"); }
  }

  reopen(projectId: UUID, fence: S5MutationFence, key: UUID, requestReferenceId: UUID, reason: S5ApprovalEvent["reopenReason"] = "user_requested"): { approval: S5PublicApproval; replayed: boolean } {
    assertUuid(key, "Idempotency-Key"); assertUuid(requestReferenceId, "x-request-id"); assertFenceInput(fence); if (reason === null) throw fail(400, "INVALID_REQUEST", "reopenReason"); const inputHash = operationInputHash("s5_reopen", projectId, { fence, reason });
    const result = this.repository.transact((state) => {
      projectIn(state, projectId); const replay = idempotencyIn(state, key, "s5_reopen", projectId, inputHash); if (replay) { const event = state.s5ApprovalEvents.find((item) => item.eventId === String(replay.eventId)); if (!event) throw fail(500, "S5_PERSISTENCE_FAILED"); return { event: cloneJson(event), replayed: true }; }
      assertS5Fence(state, projectId, fence); const previous = currentS5ApprovalEvent(state, projectId); if (!previous) throw fail(409, "S5_REOPEN_NOT_ALLOWED"); const selection = state.s3Selections.find((item) => item.projectId === projectId && item.selectionStateId === previous.selectionStateId); if (!selection || selection.activeRevisionId !== previous.observedActiveRevisionId || !selection.lineageRootRevisionId) throw fail(409, "S5_APPROVAL_STALE"); const event: S5ApprovalEvent = { schemaVersion: "s5-approval-event-v1", eventId: this.uuid(), projectId, generationSetId: selection.generationSetId, selectionStateId: selection.selectionStateId, eventSequence: previous.eventSequence + 1, approvalId: previous.approvalId, approvalGeneration: previous.approvalGeneration, observedSelectionVersion: selection.selectionVersion, observedActiveRevisionId: selection.activeRevisionId!, observedLineageRootRevisionId: selection.lineageRootRevisionId, kind: "reopened", reopenReason: reason, generationContext: null, generationContextHash: previous.generationContextHash, idempotencyKey: key, requestReferenceId, occurredAt: this.clock() }; state.s5ApprovalEvents.push(event); remember(state, key, "s5_reopen", projectId, inputHash, { eventId: event.eventId }, this.clock()); return { event: cloneJson(event), replayed: false };
    });
    return { approval: publicApproval(this.repository.state(), projectId), replayed: result.replayed };
  }

  generateLayout(projectId: UUID, fence: S5MutationFence, key: UUID, requestReferenceId: UUID): { artifactGroupId: UUID; planHash: string; artifacts: S5PublicArtifact[]; replayed: boolean } {
    assertUuid(key, "Idempotency-Key"); assertUuid(requestReferenceId, "x-request-id"); assertFenceInput(fence);
    const inputHash = operationInputHash("s5_layout", projectId, fence);
    const result = this.repository.transact((state) => {
      projectIn(state, projectId);
      const replay = idempotencyIn(state, key, "s5_layout", projectId, inputHash);
      if (replay) {
        const artifactGroupId = replay.artifactGroupId; const planHash = replay.planHash; const artifactIds = replay.artifactIds;
        if (typeof artifactGroupId !== "string" || typeof planHash !== "string" || !Array.isArray(artifactIds)) throw fail(500, "S5_PERSISTENCE_FAILED");
        return { artifactGroupId: artifactGroupId as UUID, planHash, artifactIds: artifactIds as UUID[], replayed: true };
      }
      const approval = currentApprovalOrFail(state, projectId, fence);
      const context = assertFrozenContextCurrent(state, projectId, approval, this.objects);
      const plan = planFromContext(context);
      const planBytes = canonicalPlanBytes(plan); const svgBytes = renderConceptLayoutSvg(plan);
      if (!planBytes.byteLength || !svgBytes.byteLength) throw fail(422, "S5_RENDER_FAILURE");
      const artifactGroupId = this.uuid();
      const artifacts = [
        newArtifact(context, "plan_json", artifactGroupId, plan.planHash, null, key, requestReferenceId, this.uuid, this.clock),
        newArtifact(context, "plan_svg", artifactGroupId, plan.planHash, null, key, requestReferenceId, this.uuid, this.clock),
      ];
      state.s5Artifacts.push(...artifacts);
      remember(state, key, "s5_layout", projectId, inputHash, { artifactGroupId, planHash: plan.planHash, artifactIds: artifacts.map((item) => item.artifactId) }, this.clock());
      return { artifactGroupId, planHash: plan.planHash, artifactIds: artifacts.map((item) => item.artifactId), replayed: false };
    });
    if (!result.replayed) for (const artifactId of result.artifactIds) this.processSync(artifactId);
    return { artifactGroupId: result.artifactGroupId, planHash: result.planHash, artifacts: publicArtifacts(this.repository.state(), projectId, result.artifactGroupId), replayed: result.replayed };
  }

  getLayout(projectId: UUID, layoutGroupId: UUID): S5PublicLayout {
    const state = this.repository.state(); projectIn(state, projectId); assertUuid(layoutGroupId, "layoutGroupId");
    const artifacts = publicArtifacts(state, projectId, layoutGroupId);
    if (!artifacts.length || !artifacts.some((item) => item.kind === "plan_json") || !artifacts.some((item) => item.kind === "plan_svg")) throw fail(404, "S5_ARTIFACT_NOT_FOUND");
    return { artifactGroupId: layoutGroupId, artifacts };
  }

  retryLayout(projectId: UUID, layoutGroupId: UUID, fence: S5MutationFence, key: UUID, requestReferenceId: UUID): { artifactGroupId: UUID; artifacts: S5PublicArtifact[]; replayed: boolean } {
    assertUuid(layoutGroupId, "layoutGroupId"); assertUuid(key, "Idempotency-Key"); assertUuid(requestReferenceId, "x-request-id"); assertFenceInput(fence);
    const inputHash = operationInputHash("s5_layout_retry", projectId, { layoutGroupId, fence });
    const result = this.repository.transact((state) => {
      projectIn(state, projectId); const replay = idempotencyIn(state, key, "s5_layout_retry", projectId, inputHash);
      if (replay) {
        const artifactGroupId = replay.artifactGroupId; const artifactIds = replay.artifactIds;
        if (typeof artifactGroupId !== "string" || !Array.isArray(artifactIds)) throw fail(500, "S5_PERSISTENCE_FAILED");
        return { artifactGroupId: artifactGroupId as UUID, artifactIds: artifactIds as UUID[], replayed: true };
      }
      const approval = currentApprovalOrFail(state, projectId, fence); const context = assertFrozenContextCurrent(state, projectId, approval, this.objects); const plan = planFromContext(context);
      const group = state.s5Artifacts.filter((item) => item.projectId === projectId && item.artifactGroupId === layoutGroupId);
      if (!group.some((item) => item.kind === "plan_json") || !group.some((item) => item.kind === "plan_svg")) throw fail(404, "S5_ARTIFACT_NOT_FOUND");
      if (group.some((item) => item.generationContextHash !== generationContextHash(context) || item.approvalEventId !== approval.eventId || item.planHash !== plan.planHash)) throw fail(409, "S5_APPROVAL_STALE");
      const retryIds: UUID[] = []; const replacements: S5Artifact[] = [];
      for (const kind of ["plan_json", "plan_svg"] as const) {
        const prior = group.filter((item) => item.kind === kind).sort((left, right) => right.attempt - left.attempt || right.createdAt.localeCompare(left.createdAt))[0];
        if (!prior) throw fail(404, "S5_ARTIFACT_NOT_FOUND");
        if (prior.status === "failed_retryable" && prior.attempt === 1) {
          const replacement = newArtifact(context, kind, layoutGroupId, plan.planHash, null, key, requestReferenceId, this.uuid, this.clock, prior.artifactId, 2);
          replacements.push(replacement); retryIds.push(replacement.artifactId);
        } else if (["queued", "running", "staged"].includes(prior.status)) throw fail(409, "S5_PUBLICATION_BUSY");
        else if (prior.status !== "committed") throw fail(409, "S5_RETRY_EXHAUSTED");
      }
      if (!replacements.length) throw fail(409, "S5_RETRY_EXHAUSTED");
      state.s5Artifacts.push(...replacements); remember(state, key, "s5_layout_retry", projectId, inputHash, { artifactGroupId: layoutGroupId, artifactIds: retryIds }, this.clock());
      return { artifactGroupId: layoutGroupId, artifactIds: retryIds, replayed: false };
    });
    if (!result.replayed) for (const artifactId of result.artifactIds) this.processSync(artifactId);
    return { artifactGroupId: result.artifactGroupId, artifacts: publicArtifacts(this.repository.state(), projectId, result.artifactGroupId), replayed: result.replayed };
  }

  async generatePresentation(projectId: UUID, fence: S5MutationFence, key: UUID, requestReferenceId: UUID): Promise<{ artifactId: UUID; artifactGroupId: UUID; artifacts: S5PublicArtifact[]; replayed: boolean }> {
    assertUuid(key, "Idempotency-Key"); assertUuid(requestReferenceId, "x-request-id"); assertFenceInput(fence);
    const inputHash = operationInputHash("s5_presentation", projectId, fence);
    const result = this.repository.transact((state) => {
      projectIn(state, projectId); const replay = idempotencyIn(state, key, "s5_presentation", projectId, inputHash);
      if (replay) {
        const artifactId = replay.artifactId; const artifactGroupId = replay.artifactGroupId;
        if (typeof artifactId !== "string" || typeof artifactGroupId !== "string") throw fail(500, "S5_PERSISTENCE_FAILED");
        return { artifactId: artifactId as UUID, artifactGroupId: artifactGroupId as UUID, replayed: true };
      }
      const approval = currentApprovalOrFail(state, projectId, fence); const context = assertFrozenContextCurrent(state, projectId, approval, this.objects); const plan = planFromContext(context);
      const sourceLayoutGroupId = committedLayoutGroup(state, projectId, approval, plan.planHash); if (!sourceLayoutGroupId) throw fail(409, "S5_LAYOUT_NOT_READY");
      const existing = state.s5Artifacts.filter((item) => item.projectId === projectId && item.kind === "presentation_pdf" && item.approvalEventId === approval.eventId && item.planHash === plan.planHash && item.status === "committed").sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (existing) { remember(state, key, "s5_presentation", projectId, inputHash, { artifactId: existing.artifactId, artifactGroupId: existing.artifactGroupId }, this.clock()); return { artifactId: existing.artifactId, artifactGroupId: existing.artifactGroupId, replayed: true }; }
      const artifactGroupId = this.uuid(); const artifact = newArtifact(context, "presentation_pdf", artifactGroupId, plan.planHash, sourceLayoutGroupId, key, requestReferenceId, this.uuid, this.clock);
      state.s5Artifacts.push(artifact); remember(state, key, "s5_presentation", projectId, inputHash, { artifactId: artifact.artifactId, artifactGroupId }, this.clock()); return { artifactId: artifact.artifactId, artifactGroupId, replayed: false };
    });
    if (!result.replayed) await this.processAsync(result.artifactId);
    return { artifactId: result.artifactId, artifactGroupId: result.artifactGroupId, artifacts: publicArtifacts(this.repository.state(), projectId, result.artifactGroupId), replayed: result.replayed };
  }

  getPresentation(projectId: UUID, artifactId: UUID): S5PublicArtifact {
    const state = this.repository.state(); projectIn(state, projectId); assertUuid(artifactId, "artifactId"); const artifact = state.s5Artifacts.find((item) => item.projectId === projectId && item.artifactId === artifactId && item.kind === "presentation_pdf"); if (!artifact) throw fail(404, "S5_ARTIFACT_NOT_FOUND"); return publicArtifact(artifact);
  }

  async retryPresentation(projectId: UUID, artifactId: UUID, fence: S5MutationFence, key: UUID, requestReferenceId: UUID): Promise<{ artifactId: UUID; artifactGroupId: UUID; artifacts: S5PublicArtifact[]; replayed: boolean }> {
    assertUuid(artifactId, "artifactId"); assertUuid(key, "Idempotency-Key"); assertUuid(requestReferenceId, "x-request-id"); assertFenceInput(fence);
    const inputHash = operationInputHash("s5_presentation_retry", projectId, { artifactId, fence });
    const result = this.repository.transact((state) => {
      projectIn(state, projectId); const replay = idempotencyIn(state, key, "s5_presentation_retry", projectId, inputHash);
      if (replay) {
        const storedArtifactId = replay.artifactId; const artifactGroupId = replay.artifactGroupId; if (typeof storedArtifactId !== "string" || typeof artifactGroupId !== "string") throw fail(500, "S5_PERSISTENCE_FAILED");
        return { artifactId: storedArtifactId as UUID, artifactGroupId: artifactGroupId as UUID, replayed: true };
      }
      const approval = currentApprovalOrFail(state, projectId, fence); const context = assertFrozenContextCurrent(state, projectId, approval, this.objects); const plan = planFromContext(context);
      const prior = state.s5Artifacts.find((item) => item.projectId === projectId && item.artifactId === artifactId && item.kind === "presentation_pdf"); if (!prior) throw fail(404, "S5_ARTIFACT_NOT_FOUND");
      if (prior.approvalEventId !== approval.eventId || prior.generationContextHash !== generationContextHash(context) || prior.planHash !== plan.planHash) throw fail(409, "S5_APPROVAL_STALE");
      if (["queued", "running", "staged"].includes(prior.status)) throw fail(409, "S5_PUBLICATION_BUSY");
      if (prior.status !== "failed_retryable" || prior.attempt !== 1) throw fail(409, "S5_RETRY_EXHAUSTED");
      if (!prior.sourceLayoutGroupId) throw fail(409, "S5_LAYOUT_NOT_READY");
      const replacement = newArtifact(context, "presentation_pdf", prior.artifactGroupId, plan.planHash, prior.sourceLayoutGroupId, key, requestReferenceId, this.uuid, this.clock, prior.artifactId, 2);
      state.s5Artifacts.push(replacement); remember(state, key, "s5_presentation_retry", projectId, inputHash, { artifactId: replacement.artifactId, artifactGroupId: replacement.artifactGroupId }, this.clock()); return { artifactId: replacement.artifactId, artifactGroupId: replacement.artifactGroupId, replayed: false };
    });
    if (!result.replayed) await this.processAsync(result.artifactId);
    return { artifactId: result.artifactId, artifactGroupId: result.artifactGroupId, artifacts: publicArtifacts(this.repository.state(), projectId, result.artifactGroupId), replayed: result.replayed };
  }

  getHeroDownload(projectId: UUID): S5Download {
    const state = this.repository.state(); projectIn(state, projectId); const approval = currentS5ApprovalEvent(state, projectId); if (!approval) throw fail(409, "S5_APPROVAL_REQUIRED");
    let resolved: ResolvedVisualRevision | null; try { resolved = resolveActiveVisualRevision(state, projectId, this.objects); } catch { throw fail(409, "S5_APPROVAL_STALE"); }
    if (!resolved || resolved.revisionId !== approval.observedActiveRevisionId) throw fail(409, "S5_APPROVAL_STALE"); exactActiveAsset(this.objects, resolved);
    return { bytes: this.objects.read(resolved.storageKey), contentType: "image/png", fileName: "swooshz-approved-hero.png" };
  }

  private artifactDownload(projectId: UUID, artifactId: UUID, kind: S5Artifact["kind"]): S5Download {
    const state = this.repository.state(); projectIn(state, projectId); const approval = currentS5ApprovalEvent(state, projectId); if (!approval) throw fail(409, "S5_APPROVAL_REQUIRED");
    const artifact = state.s5Artifacts.find((item) => item.projectId === projectId && item.artifactId === artifactId && item.kind === kind); if (!artifact) throw fail(404, "S5_ARTIFACT_NOT_FOUND");
    if (artifact.status !== "committed" || artifact.approvalEventId !== approval.eventId) throw fail(409, artifact.status === "queued" || artifact.status === "running" || artifact.status === "staged" ? "S5_PUBLICATION_BUSY" : "S5_APPROVAL_STALE");
    let bytes: Buffer; try { bytes = this.objects.read(artifact.artifactKey); } catch { throw fail(409, "S5_PUBLICATION_MISMATCH"); }
    if (artifact.outputSha256 === null || artifact.outputByteSize === null || sha256(bytes) !== artifact.outputSha256 || bytes.byteLength !== artifact.outputByteSize) throw fail(409, "S5_PUBLICATION_MISMATCH");
    return { bytes, contentType: artifact.mimeType, fileName: artifact.fileName };
  }

  getPresentationDownload(projectId: UUID, artifactId: UUID): S5Download { return this.artifactDownload(projectId, artifactId, "presentation_pdf"); }

  getS6ReadOnlyHandoff(projectId: UUID): Record<string, unknown> {
    const state = this.repository.state(); projectIn(state, projectId); const approval = currentS5ApprovalEvent(state, projectId);
    if (!approval) return { schemaVersion: "s5-s6-read-only-v1", projectId, readOnly: true, readiness: "not_ready", reason: "S5_APPROVAL_REQUIRED" };
    const context = assertFrozenContextCurrent(state, projectId, approval, this.objects); const plan = planFromContext(context); const layoutGroupId = committedLayoutGroup(state, projectId, approval, plan.planHash);
    const layout = layoutGroupId ? state.s5Artifacts.filter((item) => item.artifactGroupId === layoutGroupId && item.status === "committed") : [];
    const pdf = state.s5Artifacts.filter((item) => item.projectId === projectId && item.kind === "presentation_pdf" && item.approvalEventId === approval.eventId && item.planHash === plan.planHash && item.status === "committed").sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
    return { schemaVersion: "s5-s6-read-only-v1", projectId, readOnly: true, readiness: pdf ? "ready" : layoutGroupId ? "layout_ready" : "approved_visual_only", approvalEventId: approval.eventId, approvalGeneration: approval.approvalGeneration, eventSequence: approval.eventSequence, generationContextHash: approval.generationContextHash, visual: { revisionId: context.activeRevisionId, revisionKind: context.activeRevisionKind, assetId: context.activeAssetId, sha256: context.activeAssetSha256, byteSize: context.activeAssetByteSize, width: context.activeAssetWidth, height: context.activeAssetHeight, pixelCount: context.activeAssetPixelCount, quality: context.quality }, layout: { planHash: plan.planHash, rendererVersion: context.layoutRendererVersion, artifactGroupId: layoutGroupId, artifacts: layout.map((item) => ({ artifactId: item.artifactId, kind: item.kind, sha256: item.outputSha256, byteSize: item.outputByteSize, status: item.status })) }, presentation: { artifactId: pdf?.artifactId ?? null, rendererVersion: context.pdfRendererVersion, sha256: pdf?.outputSha256 ?? null, byteSize: pdf?.outputByteSize ?? null, pageCount: pdf?.pageCount ?? null, status: pdf?.status ?? "not_started" } };
  }

  getTelemetry(projectId: UUID): S5Telemetry {
    const state = this.repository.state(); projectIn(state, projectId);
    const unavailable = (): S5Telemetry => ({ approvalToPlanMs: metricUnavailable("no_durable_measurement"), approvalToPdfMs: metricUnavailable("no_durable_measurement"), artifactFailureRate: metricUnavailable("no_durable_measurement"), providerCost: metricUnavailable("actual_billed_amount_unavailable") });
    try {
      const approval = currentS5ApprovalEvent(state, projectId); const artifacts = state.s5Artifacts.filter((item) => item.projectId === projectId);
      if (!approval) return unavailable();
      const duration = (kind: S5Artifact["kind"]): S5Metric => {
        const artifact = artifacts.filter((item) => item.kind === kind && item.approvalEventId === approval.eventId && item.status === "committed" && item.completedAt !== null).sort((left, right) => right.completedAt!.localeCompare(left.completedAt!))[0];
        if (!artifact) return metricUnavailable("artifact_not_committed"); const start = Date.parse(approval.occurredAt); const end = Date.parse(artifact.completedAt!); if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return metricUnavailable("timestamp_invalid"); return { availability: "available", value: end - start, reason: null };
      };
      const terminal = artifacts.filter((item) => ["committed", "failed_retryable", "failed_terminal", "aborted"].includes(item.status)); const failed = terminal.filter((item) => ["failed_retryable", "failed_terminal", "aborted"].includes(item.status));
      return { approvalToPlanMs: duration("plan_json"), approvalToPdfMs: duration("presentation_pdf"), artifactFailureRate: terminal.length ? { availability: "available", value: failed.length / terminal.length, reason: null } : metricUnavailable("no_terminal_artifacts"), providerCost: metricUnavailable("actual_billed_amount_unavailable") };
    } catch { return unavailable(); }
  }

  private ownerState(artifact: S5Artifact): "live" | "dead" | "unknown" {
    if (artifact.processId === null || artifact.claimToken === null) return "unknown";
    try { return this.isProcessAlive(artifact.processId) ? "live" : "dead"; } catch { return "unknown"; }
  }

  private markRecoveryFailure(artifactId: UUID, token: UUID | null, code = "S5_PUBLICATION_UNCERTAIN"): void {
    this.repository.transact((state) => {
      const artifact = state.s5Artifacts.find((item) => item.artifactId === artifactId); if (!artifact || artifact.status === "committed" || (token !== null && artifact.claimToken !== token)) return;
      artifact.status = "failed_terminal"; artifact.publicationPhase = "aborted"; artifact.failureCode = code; artifact.terminalAt = this.clock(); artifact.claimToken = null; artifact.workerId = null; artifact.processId = null; artifact.claimedAt = null; artifact.updatedAt = this.clock();
    });
  }

  private recoverDeadRunning(artifact: S5Artifact): UUID | null {
    let context: S5FrozenGenerationContext;
    try {
      const state = this.repository.state(); const approval = currentS5ApprovalEvent(state, artifact.projectId); if (!approval || approval.eventId !== artifact.approvalEventId) throw new Error("stale"); context = assertFrozenContextCurrent(state, artifact.projectId, approval, this.objects);
    } catch {
      this.repository.transact((state) => { const current = state.s5Artifacts.find((item) => item.artifactId === artifact.artifactId && item.claimToken === artifact.claimToken); if (!current) return; current.status = "aborted"; current.publicationPhase = "aborted"; current.failureCode = "S5_APPROVAL_STALE"; current.terminalAt = this.clock(); current.claimToken = null; current.workerId = null; current.processId = null; current.claimedAt = null; current.updatedAt = this.clock(); });
      return null;
    }
    return this.repository.transact((state) => {
      const current = state.s5Artifacts.find((item) => item.artifactId === artifact.artifactId && item.claimToken === artifact.claimToken && item.status === "running"); if (!current) return null;
      current.status = "failed_retryable"; current.publicationPhase = "aborted"; current.failureCode = "S5_PUBLICATION_UNCERTAIN"; current.terminalAt = this.clock(); current.claimToken = null; current.workerId = null; current.processId = null; current.claimedAt = null; current.updatedAt = this.clock();
      if (current.attempt === 2) { current.status = "failed_terminal"; return null; }
      const replacement = newArtifact(context, current.kind, current.artifactGroupId, current.planHash, current.sourceLayoutGroupId, current.idempotencyKey, current.requestReferenceId, this.uuid, this.clock, current.artifactId, 2); state.s5Artifacts.push(replacement); return replacement.artifactId;
    });
  }

  private recoverStaged(artifact: S5Artifact): void {
    const token = artifact.claimToken; if (!token) { this.markRecoveryFailure(artifact.artifactId, null); return; }
    try {
      const state = this.repository.state(); const approval = currentS5ApprovalEvent(state, artifact.projectId); if (!approval || approval.eventId !== artifact.approvalEventId) throw fail(409, "S5_APPROVAL_STALE"); assertFrozenContextCurrent(state, artifact.projectId, approval, this.objects);
      let bytes: Buffer;
      if (artifact.publicationPhase === "promoted" && this.objects.exists(artifact.artifactKey)) bytes = this.objects.read(artifact.artifactKey);
      else if (this.objects.exists(artifact.stagingKey)) bytes = this.objects.read(artifact.stagingKey);
      else throw fail(500, "S5_PUBLICATION_UNCERTAIN");
      if (artifact.outputSha256 !== null && sha256(bytes) !== artifact.outputSha256 || artifact.outputByteSize !== null && bytes.byteLength !== artifact.outputByteSize) throw fail(409, "S5_PUBLICATION_MISMATCH");
      if (artifact.publicationPhase === "staged") this.objects.promoteExact(artifact.stagingKey, artifact.artifactKey, bytes);
      const promoted = this.objects.read(artifact.artifactKey); if (!contentMatches(this.objects, artifact.artifactKey, promoted)) throw fail(500, "S5_PUBLICATION_UNCERTAIN");
      this.repository.transact((currentState) => { const current = currentState.s5Artifacts.find((item) => item.artifactId === artifact.artifactId && item.claimToken === token); if (!current) throw fail(409, "S5_CLAIM_FENCED"); current.status = "staged"; current.publicationPhase = "promoted"; current.promotedAt = this.clock(); current.updatedAt = this.clock(); });
      if (this.commitArtifact(artifact.artifactId, token, promoted, artifact.pageCount)) this.objects.remove(artifact.stagingKey);
    } catch (error) {
      if (error instanceof AppError && error.code === "S5_CLAIM_FENCED") return;
      this.markRecoveryFailure(artifact.artifactId, token, error instanceof AppError && error.code === "S5_APPROVAL_STALE" ? "S5_APPROVAL_STALE" : error instanceof AppError && error.code === "S5_PUBLICATION_MISMATCH" ? "S5_PUBLICATION_MISMATCH" : "S5_PUBLICATION_UNCERTAIN");
    }
  }

  private async recoverPending(): Promise<void> {
    const pending = this.repository.state().s5Artifacts.filter((item) => item.status === "queued" || item.status === "running" || item.status === "staged");
    for (const artifact of pending) {
      const current = this.repository.state().s5Artifacts.find((item) => item.artifactId === artifact.artifactId); if (!current || (current.status !== "queued" && this.ownerState(current) !== "dead")) continue;
      if (current.status === "queued") {
        if (current.kind === "presentation_pdf") await this.processAsync(current.artifactId); else this.processSync(current.artifactId);
      } else if (current.status === "running" && current.publicationPhase === "none") {
        const replacement = this.recoverDeadRunning(current); if (replacement) { const fresh = this.repository.state().s5Artifacts.find((item) => item.artifactId === replacement); if (fresh?.kind === "presentation_pdf") await this.processAsync(replacement); else this.processSync(replacement); }
      } else if (current.status === "staged" && (current.publicationPhase === "staged" || current.publicationPhase === "promoted")) this.recoverStaged(current);
    }
  }

  async recover(): Promise<void> { await this.recoverPending(); }
}
