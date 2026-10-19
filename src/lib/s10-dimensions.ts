import { hashS6Model } from "./s6-canonical";
import { buildS7GeometryPlan, buildS7MatrixOracle } from "./s7-geometry";
import { prepareS9Grounding } from "./s9-grounding";
import { jcs, sha256 } from "./utils";
import type { S6SpatialModelRecord, S6ToS7Handoff, Sha256, UUID } from "./types";

export type S10ObjectDimension = {
  objectId: string;
  identityKey: string;
  parentObjectId: string | null;
  role: string;
  geometryState: "exact" | "bounded_inference";
  unresolvedUnknownIds: string[];
  worldOriginMm: { xMm: number; yMm: number; zMm: number };
  localGeometry:
    | { kind: "rect_prism"; widthMm: number; depthMm: number; heightMm: number; anchor: "floor" | "center" }
    | { kind: "round_prism"; radiusMm: number; heightMm: number; anchor: "floor" | "center" }
    | { kind: "profile_extrusion"; verticesMm: Array<{ xMm: number; zMm: number }>; heightMm: number; anchor: "floor" | "center" };
};

export type S10DimensionSchedule = {
  schemaVersion: "s10-dimension-schedule-v1";
  sourceRevisionId: UUID;
  sourceRevisionHash: Sha256;
  s7ValidationHash: Sha256;
  s7PlanHash: Sha256;
  s9TopControlHash: Sha256;
  units: "millimetres";
  booth: { widthMm: number; depthMm: number; maxHeightMm: number | null; heightState: "known" | "unknown"; openSides: string[] };
  objects: S10ObjectDimension[];
  scheduleHash: Sha256;
};

function reject(): never {
  throw new Error("S10_SOURCE_STALE_OR_INVALID");
}

function finiteNonnegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) reject();
  return value;
}

export function buildS10DimensionSchedule(
  model: S6SpatialModelRecord,
  handoff: S6ToS7Handoff,
): S10DimensionSchedule {
  // The S9 control independently fences the accepted S6 revision, S7 handoff,
  // canonical top camera and represented geometry before this schedule exists.
  const top = prepareS9Grounding(model, handoff, "top-orthographic");
  if (hashS6Model(model).modelHash !== handoff.acceptedRevisionHash) reject();
  const plan = buildS7GeometryPlan(handoff);
  const matrices = buildS7MatrixOracle(handoff);
  const unresolved = new Set(handoff.unknowns.filter((value) => value.status === "unresolved").map((value) => value.unknownId));
  const objects: S10ObjectDimension[] = handoff.objects.map((object) => {
    const matrix = matrices.get(object.objectId);
    if (!matrix) reject();
    const geometry = object.geometry;
    let localGeometry: S10ObjectDimension["localGeometry"];
    if (geometry.kind === "rect_prism") {
      localGeometry = {
        kind: "rect_prism",
        widthMm: finiteNonnegative(geometry.dimensionsMm.widthMm),
        depthMm: finiteNonnegative(geometry.dimensionsMm.depthMm),
        heightMm: finiteNonnegative(geometry.dimensionsMm.heightMm),
        anchor: geometry.localAnchor,
      };
    } else if (geometry.kind === "round_prism") {
      localGeometry = {
        kind: "round_prism", radiusMm: finiteNonnegative(geometry.radiusMm),
        heightMm: finiteNonnegative(geometry.heightMm), anchor: geometry.localAnchor,
      };
    } else {
      localGeometry = {
        kind: "profile_extrusion",
        verticesMm: geometry.profile.vertices.map((point) => ({ xMm: point.xMm, zMm: point.zMm })),
        heightMm: finiteNonnegative(geometry.heightMm), anchor: geometry.localAnchor,
      };
    }
    const worldOriginMm = matrix.translation;
    if (![worldOriginMm.xMm, worldOriginMm.yMm, worldOriginMm.zMm].every(Number.isFinite)) reject();
    return {
      objectId: object.objectId,
      identityKey: object.identityKey,
      parentObjectId: object.parentObjectId,
      role: object.role,
      geometryState: geometry.geometryState,
      unresolvedUnknownIds: object.unknownIds.filter((id) => unresolved.has(id)).sort(),
      worldOriginMm: { ...worldOriginMm },
      localGeometry,
    };
  });
  const identity = {
    schemaVersion: "s10-dimension-schedule-v1" as const,
    sourceRevisionId: handoff.acceptedRevisionId,
    sourceRevisionHash: handoff.acceptedRevisionHash,
    s7ValidationHash: handoff.validationReceipt.validationHash,
    s7PlanHash: sha256(jcs(plan)),
    s9TopControlHash: top.groundingHash,
    units: "millimetres" as const,
    booth: {
      widthMm: finiteNonnegative(handoff.booth.widthMm),
      depthMm: finiteNonnegative(handoff.booth.depthMm),
      maxHeightMm: handoff.booth.maxHeightMm === null ? null : finiteNonnegative(handoff.booth.maxHeightMm),
      heightState: handoff.booth.heightState,
      openSides: [...handoff.booth.openSides],
    },
    objects,
  };
  return { ...identity, scheduleHash: sha256(jcs(identity)) };
}

export function assertS10DimensionScheduleCurrent(
  schedule: S10DimensionSchedule,
  model: S6SpatialModelRecord,
  handoff: S6ToS7Handoff,
): void {
  const current = buildS10DimensionSchedule(model, handoff);
  if (schedule.scheduleHash !== current.scheduleHash || jcs(schedule) !== jcs(current)) reject();
}
