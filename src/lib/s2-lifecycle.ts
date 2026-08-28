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

function sourceHasStarted(results: readonly S2QaCandidateResult[], startedAt: Timestamp | null): boolean {
  return startedAt !== null || results.some((result) =>
    result.attempt === 2 ||
    result.status !== "queued" ||
    result.startedAt !== null ||
    result.completedAt !== null,
  );
}

/**
 * Contract-first source-QA projection.
 *
 * The four-candidate source campaign has one monotonic run-level lifecycle:
 * a pristine all-queued run is queued; once source work has started, an
 * incomplete campaign remains running across recovery and retry admission;
 * only four terminal latest results complete the source campaign. Repair and
 * re-QA never enter this projection.
 */
export function deriveSourceQaLifecycle(
  results: readonly S2QaCandidateResult[],
  current: { startedAt: Timestamp | null; completedAt: Timestamp | null },
  now: Timestamp,
): SourceQaLifecycleProjection {
  const latest = latestSourceQaResults(results);
  const allTerminal = latest.length === SOURCE_QA_CANDIDATE_INDEXES.length &&
    latest.every((result) => isSourceQaTerminalStatus(result.status));
  const started = sourceHasStarted(latest, current.startedAt);
  const status: S2QaRunStatus = allTerminal ? "completed" : started ? "running" : "queued";

  return {
    latest,
    completedCandidateCount: latest.filter((result) => isSourceQaTerminalStatus(result.status)).length,
    passCount: latest.filter((result) => result.status === "pass").length,
    warningCount: latest.filter((result) => result.status === "warning").length,
    materialFailCount: latest.filter((result) => result.status === "material_fail").length,
    unavailableCount: latest.filter((result) =>
      result.status === "qa_unavailable_retryable" || result.status === "qa_unavailable_terminal",
    ).length,
    status,
    startedAt: current.startedAt ?? (started ? now : null),
    completedAt: allTerminal ? current.completedAt ?? now : null,
  };
}
