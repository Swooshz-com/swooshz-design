import {
  canonicalS6Json,
  normalizeS6Rotation,
  roundHalfAwayFromZero,
  S6_MAX_COORDINATE_MM,
  deriveS6WorldGeometry,
} from "./s6-canonical";
import { sha256 } from "./utils";
import type { S6Camera, S6SpatialModelRecord, S6Vector3Mm, Sha256 } from "./types";

function shapeHeight(model: S6SpatialModelRecord): number {
  const world = deriveS6WorldGeometry(model);
  return world.reduce((maximum, item) => Math.max(maximum, item.boundsMm.max.yMm), 0);
}
function renderHeight(model: S6SpatialModelRecord): { value: number; basis: S6Camera["heightBasis"] } {
  if (model.booth.maxHeightMm !== null) return { value: model.booth.maxHeightMm, basis: "confirmed_max_height" };
  return { value: Math.min(S6_MAX_COORDINATE_MM, Math.max(3000, shapeHeight(model))), basis: "derived_render_height" };
}

export function hashS6Camera(camera: S6Camera): Sha256 {
  const copy = { ...camera, cameraHash: "" };
  return sha256(canonicalS6Json(copy));
}

function cameraHash(camera: S6Camera): string {
  return hashS6Camera(camera);
}

function perspective(
  viewId: S6Camera["viewId"],
  positionMm: S6Vector3Mm,
  targetMm: S6Vector3Mm,
  farMm: number,
  paddingMm: number,
  heightBasis: S6Camera["heightBasis"],
  derivedRenderHeightMm: number,
): S6Camera {
  const camera: S6Camera = {
    viewId,
    projection: "perspective",
    positionMm,
    targetMm,
    up: "world-y",
    fovMd: 45_000,
    orthoScaleMm: null,
    paddingMm,
    nearMm: 100,
    farMm,
    heightBasis,
    derivedRenderHeightMm,
    cameraHash: "" as S6Camera["cameraHash"],
  };
  camera.cameraHash = cameraHash(camera);
  return camera;
}

export function buildS6Cameras(model: S6SpatialModelRecord): S6Camera[] {
  const width = model.booth.widthMm;
  const depth = model.booth.depthMm;
  const height = renderHeight(model);
  const padding = Math.max(500, Math.min(5000, roundHalfAwayFromZero(Math.max(width, depth, height.value) / 10)));
  const center: S6Vector3Mm = {
    xMm: roundHalfAwayFromZero(width / 2),
    yMm: roundHalfAwayFromZero(height.value / 3),
    zMm: roundHalfAwayFromZero(depth / 2),
  };
  const far = Math.max(500_000, 4 * (width + depth + height.value + padding));
  const northwest = perspective(
    "perspective-northwest",
    { xMm: -padding - roundHalfAwayFromZero(width / 2), yMm: roundHalfAwayFromZero(height.value * 3 / 4), zMm: -padding - roundHalfAwayFromZero(depth / 2) },
    center,
    far,
    padding,
    height.basis,
    height.value,
  );
  const southeast = perspective(
    "perspective-southeast",
    { xMm: width + padding + roundHalfAwayFromZero(width / 2), yMm: roundHalfAwayFromZero(height.value * 3 / 4), zMm: depth + padding + roundHalfAwayFromZero(depth / 2) },
    center,
    far,
    padding,
    height.basis,
    height.value,
  );
  const top: S6Camera = {
    viewId: "top-orthographic",
    projection: "orthographic",
    positionMm: { xMm: roundHalfAwayFromZero(width / 2), yMm: height.value + 2 * padding, zMm: roundHalfAwayFromZero(depth / 2) },
    targetMm: { xMm: roundHalfAwayFromZero(width / 2), yMm: 0, zMm: roundHalfAwayFromZero(depth / 2) },
    up: "negative-world-z",
    fovMd: null,
    orthoScaleMm: Math.max(width, depth) + 2 * padding,
    paddingMm: padding,
    nearMm: 1,
    farMm: height.value + 4 * padding,
    heightBasis: height.basis,
    derivedRenderHeightMm: height.value,
    cameraHash: "" as S6Camera["cameraHash"],
  };
  top.cameraHash = cameraHash(top);
  return [northwest, southeast, top];
}
