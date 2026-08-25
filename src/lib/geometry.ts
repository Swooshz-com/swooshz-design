import { AppError, type BoothGeometry, type OpenSide } from "./types";

export const OPEN_SIDE_ORDER: readonly OpenSide[] = ["north", "east", "south", "west"];
export const MIN_DIMENSION_MM = 100;
export const MAX_DIMENSION_MM = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function metresToMillimetres(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError(400, "GEOMETRY_INVALID", [{ field: "metres", code: "FINITE_NUMBER_REQUIRED" }]);
  }
  return Math.round(value * 1000);
}

export function validateGeometry(value: unknown): BoothGeometry {
  if (!isRecord(value)) {
    throw new AppError(409, "GEOMETRY_INVALID", [{ field: "boothGeometry", code: "OBJECT_REQUIRED" }]);
  }
  const expected = new Set(["widthMm", "depthMm", "openSides", "maxHeightMm"]);
  const errors = [] as { field: string; code: string }[];
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push({ field: key, code: "REQUIRED" });
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      errors.push({ field: key, code: "UNKNOWN_FIELD" });
    }
  }
  const dimensions = ["widthMm", "depthMm", "maxHeightMm"] as const;
  for (const field of dimensions) {
    const dimension = value[field];
    if (field === "maxHeightMm" && dimension === null) continue;
    if (
      typeof dimension !== "number" ||
      !Number.isFinite(dimension) ||
      !Number.isInteger(dimension) ||
      dimension < MIN_DIMENSION_MM ||
      dimension > MAX_DIMENSION_MM
    ) {
      errors.push({ field, code: "MILLIMETRES_OUT_OF_RANGE" });
    }
  }
  const openSides = value.openSides;
  if (!Array.isArray(openSides) || openSides.length < 1 || openSides.length > 4) {
    errors.push({ field: "openSides", code: "OPEN_SIDE_REQUIRED" });
  } else {
    const seen = new Set<unknown>();
    for (const side of openSides) {
      if (!OPEN_SIDE_ORDER.includes(side as OpenSide)) {
        errors.push({ field: "openSides", code: "OPEN_SIDE_INVALID" });
      }
      if (seen.has(side)) {
        errors.push({ field: "openSides", code: "OPEN_SIDE_DUPLICATE" });
      }
      seen.add(side);
    }
  }
  if (errors.length > 0) {
    throw new AppError(409, "GEOMETRY_INVALID", errors);
  }
  return {
    widthMm: value.widthMm as number,
    depthMm: value.depthMm as number,
    openSides: OPEN_SIDE_ORDER.filter((side) => (openSides as OpenSide[]).includes(side)),
    maxHeightMm: value.maxHeightMm as number | null,
  };
}

export function geometryIsValid(value: unknown): value is BoothGeometry {
  try {
    validateGeometry(value);
    return true;
  } catch {
    return false;
  }
}
