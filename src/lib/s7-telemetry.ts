import type { S7Telemetry, StoreState, Timestamp } from "./types";
import { getS7Collections, validateS7Graph } from "./s7-persistence";
import { nowUtc } from "./utils";

function metric<T>(value: T, available = true, reason: string | null = null) {
  return available ? { availability: "available" as const, value, reason: null } : { availability: "unavailable" as const, value: null, reason };
}

export type S7SourceReadiness = { readiness: "ready" | "not_ready"; checkedAt?: Timestamp };

export function buildS7Telemetry(state: StoreState, projectId: string, source: S7SourceReadiness): S7Telemetry {
  validateS7Graph(state);
  const { exports } = getS7Collections(state);
  const projectExports = exports.filter((item) => item.projectId === projectId);
  const committed = projectExports.filter((item) => item.status === "committed");
  const retryCount = projectExports.filter((item) => item.attempt === 2).length;
  const readbackPassCount = committed.filter((item) => item.readbackReceiptId !== null && item.readbackHash !== null).length;
  const byteSize = committed.reduce((total, item) => total + (item.byteSize ?? 0), 0);
  return {
    schemaVersion: "s7-telemetry-v1",
    projectId,
    sourceReadiness: metric(source.readiness),
    exportCount: metric(projectExports.length),
    committedExportCount: metric(committed.length),
    retryCount: metric(retryCount),
    staleCount: metric(projectExports.filter((item) => item.status === "stale").length),
    supersededCount: metric(projectExports.filter((item) => item.status === "superseded").length),
    failedCount: metric(projectExports.filter((item) => item.status === "failed_retryable" || item.status === "failed_terminal").length),
    readbackPassCount: metric(readbackPassCount),
    committedDxfByteSize: metric(byteSize),
    generatedAt: nowUtc(),
  };
}
