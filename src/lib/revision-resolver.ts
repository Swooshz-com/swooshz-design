import type {
  S3RefinementRevision,
  S3Revision,
  S3SourceRevision,
  S4LocalEditRevision,
  S4Assessment,
  S4PreservationCheck,
  StoreState,
  UUID,
} from "./types";
import { PrivateObjectStore } from "./store";
import { sha256 } from "./utils";

export class RevisionResolverError extends Error {
  constructor(message = "visual revision integrity failure") {
    super(message);
    this.name = "RevisionResolverError";
  }
}

export type ResolvedVisualRevision =
  | {
      kind: "s3";
      revisionId: UUID;
      sourceSnapshotId: UUID;
      lineageRootRevisionId: UUID;
      assetId: UUID;
      storageKey: string;
      sha256: string;
      byteSize: number;
      width: 1536;
      height: 1024;
      quality: "PASS" | "WARNING";
    }
  | {
      kind: "s4";
      revisionId: UUID;
      sourceSnapshotId: UUID;
      lineageRootRevisionId: UUID;
      assetId: UUID;
      storageKey: string;
      sha256: string;
      byteSize: number;
      width: 1536;
      height: 1024;
      quality: "PASS" | "WARNING";
      preservationCheckId: UUID;
      assessmentId: UUID;
    };

export type SelectionContext = {
  generationSetId: UUID;
  selectionStateId: UUID;
  selectionVersion: number;
  activeRevisionId: UUID | null;
  lineageRootRevisionId: UUID | null;
};

function fail(message?: string): never {
  throw new RevisionResolverError(message);
}

function one<T>(items: readonly T[], message?: string): T {
  if (items.length !== 1) fail(message);
  return items[0];
}

function equalHash(actual: string, expected: string): boolean {
  return actual === expected && /^[0-9a-f]{64}$/.test(expected);
}

function staticPng(bytes: Uint8Array): boolean {
  if (bytes.length < 33 || Buffer.from(bytes.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a") return false;
  if (Buffer.from(bytes.subarray(12, 16)).toString("ascii") !== "IHDR") return false;
  if (bytes[24] !== 8 || (bytes[25] !== 6 && bytes[25] !== 4 && bytes[25] !== 2 && bytes[25] !== 0)) return false;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString("ascii");
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return false;
    if (type === "IEND") return end === bytes.length;
    offset = end;
  }
  return false;
}

function exactObject(
  objects: PrivateObjectStore,
  storageKey: string,
  expectedSha256: string,
  expectedByteSize: number,
): void {
  try {
    const bytes = objects.read(storageKey);
    const actualSha = sha256(bytes);
    const staticImage = staticPng(bytes);
    if (bytes.byteLength !== expectedByteSize || !equalHash(actualSha, expectedSha256) || !staticImage) fail();
  } catch {
    fail();
  }
}

function selectionFor(state: StoreState, projectId: UUID): SelectionContext {
  const project = one(state.projects.filter((item) => item.projectId === projectId), "project");
  if (!project.activeGenerationSetId) fail("generation");
  const selections = state.s3Selections.filter((item) => item.projectId === projectId && item.generationSetId === project.activeGenerationSetId);
  const selection = one(selections, "selection");
  return {
    generationSetId: project.activeGenerationSetId,
    selectionStateId: selection.selectionStateId,
    selectionVersion: selection.selectionVersion,
    activeRevisionId: selection.activeRevisionId,
    lineageRootRevisionId: selection.lineageRootRevisionId,
  };
}

function selectionRecord(state: StoreState, projectId: UUID, context: SelectionContext) {
  return one(state.s3Selections.filter((item) => item.projectId === projectId &&
    item.generationSetId === context.generationSetId && item.selectionStateId === context.selectionStateId), "selection");
}

function sourceFor(state: StoreState, projectId: UUID, generationSetId: UUID, sourceSnapshotId: UUID) {
  return one(state.s3Sources.filter((item) => item.sourceSnapshotId === sourceSnapshotId &&
    item.projectId === projectId && item.generationSetId === generationSetId), "source");
}

function inputFor(state: StoreState, projectId: UUID, inputId: UUID) {
  return one(state.s2Inputs.filter((item) => item.id === inputId && item.projectId === projectId), "input");
}

function sameGenerationContext(selection: ReturnType<typeof selectionRecord>, source: StoreState["s3Sources"][number], input: StoreState["s2Inputs"][number]): void {
  if (source.s2InputVersionId !== selection.s2InputVersionId || source.s2InputBindingHash !== selection.s2InputBindingHash ||
      source.confirmedBriefVersionId !== selection.confirmedBriefVersionId ||
      source.confirmedBriefContentHash !== selection.confirmedBriefContentHash ||
      source.geometryHash !== selection.geometryHash || input.geometryHash !== selection.geometryHash ||
      input.requirementHash !== source.requirementHash || input.designRulesVersion !== source.designRulesVersion) fail("context");
}

function sourceAssetForS3(state: StoreState, source: StoreState["s3Sources"][number], revision: S3SourceRevision, objects: PrivateObjectStore): void {
  if (revision.outputAssetId !== source.selectedAssetId || revision.outputSha256 !== source.selectedSha256 ||
      revision.outputByteSize !== source.selectedByteSize || revision.outputWidth !== source.selectedWidth ||
      revision.outputHeight !== source.selectedHeight || revision.outputPixelCount !== source.selectedPixelCount) fail("source asset");
  exactObject(objects, source.selectedStorageKey, source.selectedSha256, source.selectedByteSize);
}

function s3Revision(
  state: StoreState,
  projectId: UUID,
  context: SelectionContext,
  revision: S3Revision,
  objects: PrivateObjectStore,
): ResolvedVisualRevision {
  if (revision.projectId !== projectId || revision.generationSetId !== context.generationSetId ||
      revision.lineageRootRevisionId !== context.lineageRootRevisionId) fail("s3 revision context");
  const source = sourceFor(state, projectId, context.generationSetId, revision.sourceSnapshotId);
  const selection = selectionRecord(state, projectId, context);
  const input = inputFor(state, projectId, source.s2InputVersionId);
  sameGenerationContext(selection, source, input);
  if (revision.confirmedBriefVersionId !== selection.confirmedBriefVersionId ||
      revision.confirmedBriefContentHash !== selection.confirmedBriefContentHash ||
      revision.geometryHash !== selection.geometryHash || revision.s2InputVersionId !== selection.s2InputVersionId ||
      revision.s2InputBindingHash !== selection.s2InputBindingHash || revision.sourceBindingHash !== source.sourceBindingHash) fail("s3 frozen context");
  if (revision.kind === "source_selection") {
    if (revision.parentRevisionId !== null || revision.refinementCycleNumber !== 0 || revision.assessmentId !== null) fail("source revision shape");
    if (revision.revisionId !== source.sourceRootRevisionId || revision.lineageRootRevisionId !== revision.revisionId) fail("source root");
    if (source.canonicalSourceBinding.eligibilityVerdict !== "PASS" && source.canonicalSourceBinding.eligibilityVerdict !== "WARNING") fail("source quality");
    sourceAssetForS3(state, source, revision, objects);
    return {
      kind: "s3",
      revisionId: revision.revisionId,
      sourceSnapshotId: source.sourceSnapshotId,
      lineageRootRevisionId: revision.lineageRootRevisionId,
      assetId: revision.outputAssetId,
      storageKey: source.selectedStorageKey,
      sha256: revision.outputSha256,
      byteSize: revision.outputByteSize,
      width: 1536,
      height: 1024,
      quality: source.canonicalSourceBinding.eligibilityVerdict,
    };
  }
  const parent = state.s3Revisions.filter((item) => item.revisionId === revision.parentRevisionId);
  const parentRevision = one(parent, "s3 parent");
  if (parentRevision.kind !== "source_selection" && parentRevision.kind !== "refinement") fail("s3 parent");
  if (revision.parentRevisionId === revision.revisionId) fail("s3 parent kind");
  const assessment = one(state.s3Assessments.filter((item) => item.assessmentId === revision.assessmentId &&
    item.projectId === projectId && item.generationSetId === context.generationSetId &&
    item.revisionId === revision.revisionId), "s3 assessment");
  if (assessment.status !== "pass" && assessment.status !== "warning") fail("s3 quality");
  const asset = one(state.s3Assets.filter((item) => item.assetId === revision.outputAssetId &&
    item.projectId === projectId && item.generationSetId === context.generationSetId &&
    item.revisionId === revision.revisionId), "s3 asset");
  if (asset.normalizedSha256 !== revision.outputSha256 || asset.normalizedBytes !== revision.outputByteSize ||
      asset.width !== 1536 || asset.height !== 1024 || asset.pixelCount !== 1_572_864) fail("s3 asset identity");
  exactObject(objects, asset.storageKeyNormalized, asset.normalizedSha256, asset.normalizedBytes);
  if (!state.s3SelectionEvents.some((item) => item.kind === "activate_refinement" && item.toRevisionId === revision.revisionId &&
      item.selectionStateId === context.selectionStateId)) fail("s3 activation");
  return {
    kind: "s3",
    revisionId: revision.revisionId,
    sourceSnapshotId: source.sourceSnapshotId,
    lineageRootRevisionId: revision.lineageRootRevisionId,
    assetId: revision.outputAssetId,
    storageKey: asset.storageKeyNormalized,
    sha256: revision.outputSha256,
    byteSize: revision.outputByteSize,
    width: 1536,
    height: 1024,
    quality: assessment.status === "pass" ? "PASS" : "WARNING",
  };
}

function s4SourceQuality(
  state: StoreState,
  revision: S4LocalEditRevision,
  parent: ResolvedVisualRevision,
): void {
  const quality = revision.sourceQuality;
  if (parent.kind === "s3") {
    if (parent.revisionId === parent.lineageRootRevisionId) {
      if (quality.kind !== "s3_source" || quality.sourceRevisionId !== parent.revisionId ||
          quality.sourceSnapshotId !== parent.sourceSnapshotId || quality.sourceBindingHash === "") fail("s4 source quality");
    } else {
      if (quality.kind !== "s3_refinement" || quality.sourceRevisionId !== parent.revisionId ||
          quality.sourceSnapshotId !== parent.sourceSnapshotId || quality.assessmentId === "") fail("s4 source quality");
    }
    return;
  }
  if (quality.kind !== "s4_local_edit" || quality.sourceRevisionId !== parent.revisionId ||
      quality.sourceSnapshotId !== parent.sourceSnapshotId || quality.preservationCheckId === "" ||
      quality.assessmentId === "") fail("s4 source quality");
  const preservation = one(state.s4PreservationChecks.filter((item) => item.preservationCheckId === quality.preservationCheckId &&
    item.revisionId === parent.revisionId), "s4 source preservation");
  const assessment = one(state.s4Assessments.filter((item) => item.assessmentId === quality.assessmentId &&
    item.revisionId === parent.revisionId), "s4 source assessment");
  if (preservation.status !== "PASS" || assessment.status !== "pass" && assessment.status !== "warning") fail("s4 source quality");
}

function s4Revision(
  state: StoreState,
  projectId: UUID,
  context: SelectionContext,
  revision: S4LocalEditRevision,
  objects: PrivateObjectStore,
  visited = new Set<UUID>(),
): ResolvedVisualRevision {
  if (visited.has(revision.revisionId)) fail("s4 revision cycle");
  visited.add(revision.revisionId);
  if (revision.projectId !== projectId || revision.generationSetId !== context.generationSetId ||
      revision.selectionStateId !== context.selectionStateId ||
      revision.sourceSnapshotId === "" || revision.lineageRootRevisionId !== context.lineageRootRevisionId ||
      revision.kind !== "s4_local_edit") fail("s4 revision context");
  const source = sourceFor(state, projectId, context.generationSetId, revision.sourceSnapshotId);
  const selection = selectionRecord(state, projectId, context);
  const input = inputFor(state, projectId, source.s2InputVersionId);
  sameGenerationContext(selection, source, input);
  if (revision.sourceSnapshotId !== source.sourceSnapshotId ||
      revision.sourceAssetId === revision.outputAssetId ||
      revision.outputWidth !== 1536 || revision.outputHeight !== 1024 ||
      revision.outputPixelCount !== 1_572_864 ||
      revision.sourceWidth !== 1536 || revision.sourceHeight !== 1024 ||
      revision.sourcePixelCount !== 1_572_864) fail("s4 revision identity");
  const parentCandidates = revision.parentRevisionKind === "s3"
    ? state.s3Revisions.filter((item) => item.revisionId === revision.parentRevisionId)
    : state.s4Revisions.filter((item) => item.revisionId === revision.parentRevisionId);
  if (parentCandidates.length !== 1) fail("s4 parent");
  const parent = parentCandidates[0];
  const resolvedParent = parentCandidates[0].kind === "s4_local_edit"
    ? s4Revision(state, projectId, context, parentCandidates[0], objects, new Set(visited))
    : s3Revision(state, projectId, context, parentCandidates[0], objects);
  if (resolvedParent.revisionId !== revision.parentRevisionId ||
      resolvedParent.kind !== revision.parentRevisionKind ||
      resolvedParent.sourceSnapshotId !== revision.sourceSnapshotId ||
      resolvedParent.lineageRootRevisionId !== revision.lineageRootRevisionId ||
      resolvedParent.assetId !== revision.sourceAssetId ||
      resolvedParent.sha256 !== revision.sourceSha256 ||
      resolvedParent.byteSize !== revision.sourceByteSize) fail("s4 parent identity");
  s4SourceQuality(state, revision, resolvedParent);
  const stage = one(state.s4Stages.filter((item) => item.projectId === projectId &&
    item.generationSetId === context.generationSetId && item.selectionStateId === context.selectionStateId &&
    item.sourceSnapshotId === source.sourceSnapshotId && item.lineageRootRevisionId === context.lineageRootRevisionId), "s4 stage");
  if (revision.cycleNumber < 1 || revision.cycleNumber > stage.cyclesConsumed || revision.editId === "") fail("s4 stage");
  const edit = one(state.s4Edits.filter((item) => item.editId === revision.editId &&
    item.projectId === projectId && item.generationSetId === context.generationSetId &&
    item.selectionStateId === context.selectionStateId), "s4 edit");
  if (edit.outputRevisionId !== revision.revisionId || edit.baseRevisionId !== revision.parentRevisionId ||
      edit.baseRevisionKind !== revision.parentRevisionKind || edit.maskId !== revision.maskId ||
      edit.maskIdentityHash !== revision.maskIdentityHash || edit.cycleNumber !== revision.cycleNumber) fail("s4 edit link");
  const mask = one(state.s4Masks.filter((item) => item.maskId === revision.maskId && item.editId === revision.editId &&
    item.projectId === projectId && item.generationSetId === context.generationSetId), "s4 mask");
  if (mask.maskIdentityHash !== revision.maskIdentityHash || mask.sourceRevisionId !== revision.parentRevisionId ||
      mask.sourceAssetId !== revision.sourceAssetId) fail("s4 mask identity");
  const asset = one(state.s4Assets.filter((item) => item.assetId === revision.outputAssetId &&
    item.projectId === projectId && item.generationSetId === context.generationSetId &&
    item.revisionId === revision.revisionId), "s4 asset");
  if (asset.normalizedSha256 !== revision.outputSha256 || asset.normalizedBytes !== revision.outputByteSize ||
      asset.width !== 1536 || asset.height !== 1024 || asset.pixelCount !== 1_572_864 ||
      asset.providerOutputSha256 !== revision.outputSha256 || asset.providerOutputBytes !== revision.outputByteSize) fail("s4 asset identity");
  exactObject(objects, asset.storageKeyNormalized, asset.normalizedSha256, asset.normalizedBytes);
  const preservation = one(state.s4PreservationChecks.filter((item) => item.preservationCheckId === revision.preservationCheckId &&
    item.revisionId === revision.revisionId && item.editId === revision.editId), "s4 preservation");
  const assessment = one(state.s4Assessments.filter((item) => item.assessmentId === revision.assessmentId &&
    item.revisionId === revision.revisionId && item.editId === revision.editId), "s4 assessment");
  if (preservation.status !== "PASS" || preservation.noOpDetected !== false ||
      assessment.status !== "pass" && assessment.status !== "warning" ||
      assessment.requestedEditSatisfaction !== "satisfied" || assessment.noOpDetected) fail("s4 quality");
  if (assessment.latestAttemptId === null || assessment.attemptIds.length < 1 ||
      !assessment.attemptIds.some((item) => item === assessment.latestAttemptId)) fail("s4 attempt");
  const attempt = one(state.s4AssessmentAttempts.filter((item) => item.assessmentAttemptId === assessment.latestAttemptId &&
    item.assessmentId === assessment.assessmentId), "s4 latest attempt");
  if (attempt.status !== "succeeded" || attempt.disposition !== "pass" && attempt.disposition !== "warning" ||
      attempt.outputSha256 !== revision.outputSha256 || attempt.assessmentInputHash !== assessment.assessmentInputHash ||
      attempt.assessmentPromptHash !== assessment.assessmentPromptHash) fail("s4 attempt result");
  if (!state.s4Transitions.some((item) => item.phase === "activation" && item.resultingRevisionId === revision.revisionId &&
      item.selectionStateId === context.selectionStateId)) fail("s4 activation");
  return {
    kind: "s4",
    revisionId: revision.revisionId,
    sourceSnapshotId: revision.sourceSnapshotId,
    lineageRootRevisionId: revision.lineageRootRevisionId,
    assetId: revision.outputAssetId,
    storageKey: asset.storageKeyNormalized,
    sha256: revision.outputSha256,
    byteSize: revision.outputByteSize,
    width: 1536,
    height: 1024,
    quality: assessment.status === "pass" ? "PASS" : "WARNING",
    preservationCheckId: preservation.preservationCheckId,
    assessmentId: assessment.assessmentId,
  };
}

function revisionById(state: StoreState, projectId: UUID, context: SelectionContext, revisionId: UUID, objects: PrivateObjectStore): ResolvedVisualRevision {
  const s3 = state.s3Revisions.filter((item) => item.revisionId === revisionId);
  const s4 = state.s4Revisions.filter((item) => item.revisionId === revisionId);
  if (s3.length + s4.length !== 1) fail("revision id uniqueness");
  const revision = s4.length === 1 ? s4[0] : s3[0];
  return revision.kind === "s4_local_edit"
    ? s4Revision(state, projectId, context, revision, objects)
    : s3Revision(state, projectId, context, revision, objects);
}

export function resolveActiveVisualRevision(state: StoreState, projectId: UUID, objects: PrivateObjectStore): ResolvedVisualRevision | null {
  const context = selectionFor(state, projectId);
  if (context.activeRevisionId === null) return null;
  if (context.lineageRootRevisionId === null) fail("active lineage");
  return revisionById(state, projectId, context, context.activeRevisionId, objects);
}

export function resolveVisualRevision(state: StoreState, projectId: UUID, revisionId: UUID, objects: PrivateObjectStore): ResolvedVisualRevision {
  const context = selectionFor(state, projectId);
  if (context.activeRevisionId === null || context.lineageRootRevisionId === null) fail("selection inactive");
  return revisionById(state, projectId, context, revisionId, objects);
}

export function getSelectionContext(state: StoreState, projectId: UUID): SelectionContext {
  return selectionFor(state, projectId);
}
