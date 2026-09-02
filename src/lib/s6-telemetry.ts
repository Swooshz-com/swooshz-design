import { nowUtc } from "./utils";
import { validateS6Graph } from "./s6-persistence";
import {
  S6_TELEMETRY_SCHEMA_VERSION,
} from "./s6-canonical";
import type {
  S6Metric,
  S6PublicState,
  S6Telemetry,
  StoreState,
  Timestamp,
  UUID,
} from "./types";

function available<T>(value: T): S6Metric<T> {
  return { availability: "available", value, reason: null };
}

function unavailable<T>(reason: string): S6Metric<T> {
  return { availability: "unavailable", value: null, reason };
}

function metric<T>(value: T, valid: boolean): S6Metric<T> {
  return valid ? available(value) : unavailable("s6_state_invalid");
}

function sourceMetric(sourceStatus: S6PublicState["source"]): S6Metric<"ready" | "not_ready"> {
  return sourceStatus.readiness === "ready" ? available("ready") : available("not_ready");
}

export function buildS6Telemetry(
  state: StoreState,
  projectId: UUID,
  sourceStatus: S6PublicState["source"],
): S6Telemetry {
  let valid = true;
  try {
    validateS6Graph(state);
  } catch {
    valid = false;
  }
  const models = state.s6SpatialModels.filter((item) => item.projectId === projectId);
  const jobs = state.s6Jobs.filter((item) => item.projectId === projectId);
  const corrections = state.s6CorrectionEvents.filter((item) => item.projectId === projectId);
  const acceptances = state.s6AcceptanceEvents.filter((item) => item.projectId === projectId);
  const sourceModels = sourceStatus.sourceS5Fingerprint === null
    ? []
    : models.filter((item) => item.sourceS5Fingerprint === sourceStatus.sourceS5Fingerprint);
  const accepted = sourceStatus.sourceS5Fingerprint === null
    ? null
    : sourceModels.find((item) => item.status === "accepted_current") ?? null;
  const renderJobs = jobs.filter((item) => item.kind === "render");
  const renderFailures = renderJobs.filter((item) => item.status === "failed_terminal" || item.status === "failed_retryable").length;
  const publicationFailures = jobs.filter((item) =>
    item.kind === "publication" &&
    (item.status === "failed_terminal" || item.status === "failed_retryable"),
  ).length;
  const preservationFailures = state.s6ViewPreservationReceipts.filter((item) =>
    item.projectId === projectId && item.outcome === "fail",
  ).length;
  const acceptedViewCount = sourceStatus.sourceS5Fingerprint === null
    ? 0
    : state.s6ViewArtifacts.filter((item) =>
      item.projectId === projectId &&
      item.sourceS5Fingerprint === sourceStatus.sourceS5Fingerprint &&
      item.purpose === "accepted_view" &&
      item.status === "committed",
    ).length;
  const latestModel = sourceModels
    .slice()
    .sort((left, right) => right.revisionNumber - left.revisionNumber)[0] ?? null;
  const modelByteSize = accepted?.modelArtifact.byteSize ??
    latestModel?.modelArtifact.byteSize ??
    null;
  return {
    schemaVersion: S6_TELEMETRY_SCHEMA_VERSION,
    projectId,
    sourceReadiness: sourceMetric(sourceStatus),
    generationCount: metric(jobs.filter((item) => item.kind === "generation" && item.status === "committed").length, valid),
    correctionCount: metric(corrections.filter((item) => item.operations.length > 0).length, valid),
    correctionFailureCount: unavailable("not_durably_recorded"),
    reopenCount: metric(corrections.filter((item) => item.operations.length === 0).length, valid),
    acceptanceCount: metric(acceptances.length, valid),
    revisionConflictCount: unavailable("not_durably_recorded"),
    staleFenceCount: unavailable("not_durably_recorded"),
    renderRequestCount: metric(renderJobs.length, valid),
    renderSuccessCount: metric(renderJobs.filter((item) => item.status === "committed").length, valid),
    renderFailureCount: metric(renderFailures, valid),
    viewPreservationFailureCount: metric(preservationFailures, valid),
    publicationFailureCount: metric(publicationFailures, valid),
    acceptedViewCount: metric(acceptedViewCount, valid),
    fullModelByteSize: valid && modelByteSize !== null
      ? available(modelByteSize)
      : valid
        ? unavailable("no_current_model")
        : unavailable("s6_state_invalid"),
    providerCost: unavailable("no_provider_used"),
    toolCost: unavailable("no_billed_tool_amount"),
    generatedAt: nowUtc() as Timestamp,
  };
}
