import { AppError } from "./types";
import type { S5ApprovalEvent, S5MutationFence, StoreState, UUID } from "./types";

export function latestS5Event(state: StoreState, projectId: UUID): S5ApprovalEvent | null {
  return state.s5ApprovalEvents
    .filter((item) => item.projectId === projectId)
    .sort((left, right) => right.eventSequence - left.eventSequence)[0] ?? null;
}

export function currentS5ApprovalEvent(state: StoreState, projectId: UUID): S5ApprovalEvent | null {
  const latest = latestS5Event(state, projectId);
  return latest?.kind === "approved" ? latest : null;
}

export function isS5ApprovalLocked(state: StoreState, projectId: UUID): boolean {
  return currentS5ApprovalEvent(state, projectId) !== null;
}

export function currentS5Fence(state: StoreState, projectId: UUID): S5MutationFence {
  const project = state.projects.find((item) => item.projectId === projectId);
  if (!project?.activeGenerationSetId) throw new AppError(409, "S5_NOT_READY");
  const selection = state.s3Selections.find((item) => item.projectId === projectId && item.generationSetId === project.activeGenerationSetId);
  if (!selection || !selection.activeRevisionId) throw new AppError(409, "S5_NOT_READY");
  const latest = latestS5Event(state, projectId);
  return {
    expectedGenerationSetId: selection.generationSetId,
    expectedSelectionStateId: selection.selectionStateId,
    expectedSelectionVersion: selection.selectionVersion,
    expectedActiveRevisionId: selection.activeRevisionId,
    expectedApprovalEventId: latest?.eventId ?? null,
    expectedApprovalGeneration: latest?.approvalGeneration ?? 0,
    expectedApprovalEventSequence: latest?.eventSequence ?? 0,
  };
}

function sameFence(left: S5MutationFence, right: S5MutationFence): boolean {
  return left.expectedGenerationSetId === right.expectedGenerationSetId &&
    left.expectedSelectionStateId === right.expectedSelectionStateId &&
    left.expectedSelectionVersion === right.expectedSelectionVersion &&
    left.expectedActiveRevisionId === right.expectedActiveRevisionId &&
    left.expectedApprovalEventId === right.expectedApprovalEventId &&
    left.expectedApprovalGeneration === right.expectedApprovalGeneration &&
    left.expectedApprovalEventSequence === right.expectedApprovalEventSequence;
}

export function assertS5Fence(state: StoreState, projectId: UUID, expected: S5MutationFence): void {
  let current: S5MutationFence;
  try { current = currentS5Fence(state, projectId); } catch { throw new AppError(409, "S5_APPROVAL_STALE"); }
  if (!sameFence(current, expected)) throw new AppError(409, "S5_APPROVAL_STALE");
}

export function assertS5ApprovalFence(state: StoreState, projectId: UUID, expected: S5MutationFence): S5ApprovalEvent {
  assertS5Fence(state, projectId, expected);
  const approval = currentS5ApprovalEvent(state, projectId);
  if (!approval || expected.expectedApprovalEventId !== approval.eventId) throw new AppError(409, "S5_APPROVAL_STALE");
  return approval;
}

export function assertS5MutationAllowed(state: StoreState, projectId: UUID): void {
  if (isS5ApprovalLocked(state, projectId)) throw new AppError(409, "S5_APPROVAL_LOCKED");
}

export function assertS5MutationAllowedOrProjectMissing(state: StoreState, projectId: UUID): void {
  if (!state.projects.some((item) => item.projectId === projectId)) throw new AppError(404, "PROJECT_NOT_FOUND");
  assertS5MutationAllowed(state, projectId);
}
