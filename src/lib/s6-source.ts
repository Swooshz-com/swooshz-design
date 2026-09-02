import { AppError, type S5ToS6Projection, type Sha256, type UUID } from "./types";
import { canonicalS6Json, S6_SOURCE_FINGERPRINT_VERSION } from "./s6-canonical";
import { JsonRepository, PrivateObjectStore } from "./store";
import { cloneJson, sha256, uuidV4Pattern } from "./utils";

export type S6SourceReader = {
  readReady(projectId: UUID): S5ToS6Projection;
  currentFingerprint(projectId: UUID): Sha256;
  assertCurrent(projectId: UUID, expectedFingerprint: Sha256): S5ToS6Projection;
};

export type S6ProjectionReader = (projectId: UUID) => S5ToS6Projection;

function sourceError(code: "S6_SOURCE_STALE" | "S6_SOURCE_NOT_READY"): AppError {
  return new AppError(409, code, [{ field: "source", code }]);
}

function sourceFingerprintInput(projection: S5ToS6Projection): Record<string, unknown> {
  return {
    schemaVersion: S6_SOURCE_FINGERPRINT_VERSION,
    projectId: projection.projectId,
    generationSetId: projection.generationSetId,
    selectionStateId: projection.selectionStateId,
    selectionVersion: projection.selectionVersion,
    approvalEventId: projection.approvalEventId,
    approvalGeneration: projection.approvalGeneration,
    eventSequence: projection.eventSequence,
    generationContextHash: projection.generationContextHash,
    activeRevisionId: projection.activeRevisionId,
    activeRevisionKind: projection.activeRevisionKind,
    sourceSnapshotId: projection.sourceSnapshotId,
    lineageRootRevisionId: projection.lineageRootRevisionId,
    sourceBindingHash: projection.sourceBindingHash,
    quality: projection.quality,
    activeAsset: {
      assetId: projection.activeAsset.assetId,
      sha256: projection.activeAsset.sha256,
      byteSize: projection.activeAsset.byteSize,
      width: projection.activeAsset.width,
      height: projection.activeAsset.height,
      pixelCount: projection.activeAsset.pixelCount,
    },
    confirmedBriefVersionId: projection.confirmedBriefVersionId,
    briefContentHash: projection.briefContentHash,
    visualIntentSourceHash: projection.visualIntent.sourceHash,
    geometrySnapshot: projection.geometrySnapshot,
    geometryHash: projection.geometryHash,
    canonicalRequirements: projection.canonicalRequirements,
    requirementHash: projection.requirementHash,
    layoutRequirements: projection.layoutRequirements,
    layoutRequirementsHash: projection.layoutRequirementsHash,
    designRulesVersion: projection.designRulesVersion,
    designRuleSnapshot: projection.designRuleSnapshot,
    designRuleSnapshotHash: projection.designRuleSnapshotHash,
    layoutPlan: {
      schemaVersion: projection.layoutPlan.schemaVersion,
      planHash: projection.layoutPlan.planHash,
    },
    layoutRendererVersion: projection.layoutArtifacts.planJson.rendererVersion,
  };
}

export function s6SourceFingerprint(projection: S5ToS6Projection): Sha256 {
  return sha256(new TextEncoder().encode(canonicalS6Json(sourceFingerprintInput(projection))));
}

function assertProjectionShape(projectId: UUID, projection: S5ToS6Projection): void {
  if (
    projection.projectId !== projectId ||
    projection.readOnly !== true ||
    projection.readiness !== "ready" ||
    !uuidV4Pattern.test(projection.approvalEventId) ||
    !uuidV4Pattern.test(projection.activeAsset.assetId) ||
    projection.activeAsset.width !== 1536 ||
    projection.activeAsset.height !== 1024 ||
    projection.activeAsset.pixelCount !== 1_572_864
  ) {
    throw sourceError("S6_SOURCE_NOT_READY");
  }
}

export function createS6SourceReader(
  repository: JsonRepository,
  objects: PrivateObjectStore,
  projectionReader: S6ProjectionReader,
): S6SourceReader {
  void repository;
  void objects;
  const readReady = (projectId: UUID): S5ToS6Projection => {
    let projection: S5ToS6Projection;
    try {
      projection = projectionReader(projectId);
    } catch (error) {
      if (error instanceof AppError && (error.code === "S6_SOURCE_NOT_READY" || error.code === "S6_SOURCE_STALE")) throw error;
      throw sourceError("S6_SOURCE_NOT_READY");
    }
    assertProjectionShape(projectId, projection);
    if (projection.sourceFingerprint !== s6SourceFingerprint(projection)) throw sourceError("S6_SOURCE_NOT_READY");
    return cloneJson(projection);
  };
  return {
    readReady,
    currentFingerprint: (projectId) => readReady(projectId).sourceFingerprint,
    assertCurrent: (projectId, expectedFingerprint) => {
      const projection = readReady(projectId);
      if (projection.sourceFingerprint !== expectedFingerprint) throw sourceError("S6_SOURCE_STALE");
      return projection;
    },
  };
}
