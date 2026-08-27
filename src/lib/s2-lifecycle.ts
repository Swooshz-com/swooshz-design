import type { S2CandidateStatus, S2QaCandidateResult, S2QaRunStatus, Timestamp } from "./types";

export const SOURCE_QA_CANDIDATE_INDEXES = [1, 2, 3, 4] as const;

export const SOURCE_QA_TERMINAL_STATUSES: readonly S2CandidateStatus[] = [
  "pass",
  "warning",
  "material_fail",
  "qa_unavailable_retryable",
  "qa_unavailable_terminal",
];

export function isSourceQaTerminalStatus(status: string): boolean {
  return (SOURCE_QA_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Return the canonical source-QA result for each of the four source candidates.
 * This is intentionally a pure projection; callers own validation and mutation.
 */
export function latestSourceQaResults(results: readonly S2QaCandidateResult[]): S2QaCandidateResult[] {
  return SOURCE_QA_CANDIDATE_INDEXES.flatMap((candidateIndex) => {
    const candidates = results
      .filter((result) => result.candidateIndex === candidateIndex)
      .slice()
      .sort((left, right) => right.attempt - left.attempt);
    return candidates.length > 0 ? [candidates[0]] : [];
  });
}

export type SourceQaLifecycleProjection = {
  latest: S2QaCandidateResult[];
  completedCandidateCount: number;
  passCount: number;
  warningCount: number;
  materialFailCount: number;
  unavailableCount: number;
  status: S2QaRunStatus;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
};

export function deriveSourceQaLifecycle(
  results: readonly S2QaCandidateResult[],
  current: { startedAt: Timestamp | null; completedAt: Timestamp | null },
  now: Timestamp,
): SourceQaLifecycleProjection {
  const latest = latestSourceQaResults(results);
  const hasRunning = latest.some((result) => result.status === "running");
  const allTerminal = latest.length === SOURCE_QA_CANDIDATE_INDEXES.length &&
    latest.every((result) => isSourceQaTerminalStatus(result.status));
  const status: S2QaRunStatus = allTerminal ? "completed" : hasRunning ? "running" : "queued";

  return {
    latest,
    completedCandidateCount: latest.filter((result) => isSourceQaTerminalStatus(result.status)).length,
    passCount: latest.filter((result) => result.status === "pass").length,
    warningCount: latest.filter((result) => result.status === "warning").length,
    materialFailCount: latest.filter((result) => result.status === "material_fail").length,
    unavailableCount: latest.filter((result) => result.status === "qa_unavailable_retryable" || result.status === "qa_unavailable_terminal").length,
    status,
    startedAt: current.startedAt ?? (hasRunning ? now : null),
    completedAt: allTerminal ? current.completedAt ?? now : null,
  };
}
