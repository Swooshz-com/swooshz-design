import {
  canonicalS6Json,
  deriveS6Footprint,
  hashS6Model,
  normalizeS6Geometry,
  roundHalfAwayFromZero,
  S6_RENDERER_VERSION,
  S6_RENDER_Q16,
  S6_MAX_VIEW_BYTES,
} from "./s6-canonical";
import { sha256 } from "./utils";
import type {
  S6Camera,
  S6Dimensions,
  S6GeometryPrimitive,
  S6MaterialFinishRef,
  S6RenderedView,
  S6SceneEvidence,
  S6SpatialModelRecord,
  S6SpatialObject,
  S6Vector3Mm,
} from "./types";

type Point3 = { x: number; y: number; z: number };
type Point2 = { x: number; y: number; depth: number };
type Face = { object: S6SpatialObject; points: Point3[]; depth: number; index: number; materialId: string | null };
type CameraBasis = { forward: Point3; right: Point3; up: Point3; focalDistance: number };

const VIEWPORT_UNITS = 1_000;

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function transformPoint(point: Point3, object: S6SpatialObject): Point3 {
  const rx = object.transform.rotationMd.xMd * Math.PI / 180_000;
  const ry = object.transform.rotationMd.yMd * Math.PI / 180_000;
  const rz = object.transform.rotationMd.zMd * Math.PI / 180_000;
  const cx = Math.cos(rx); const sx = Math.sin(rx);
  const cy = Math.cos(ry); const sy = Math.sin(ry);
  const cz = Math.cos(rz); const sz = Math.sin(rz);
  const x1 = point.x;
  const y1 = point.y * cx - point.z * sx;
  const z1 = point.y * sx + point.z * cx;
  const x2 = x1 * cy + z1 * sy;
  const y2 = y1;
  const z2 = -x1 * sy + z1 * cy;
  return {
    x: object.transform.positionMm.xMm + x2 * cz - y2 * sz,
    y: object.transform.positionMm.yMm + x2 * sz + y2 * cz,
    z: object.transform.positionMm.zMm + z2,
  };
}

function anchorY(object: S6SpatialObject, height: number, value: number): number {
  return object.primitive.localAnchor === "center" ? value - height / 2 : value;
}

function rectPoints(object: S6SpatialObject): Point3[] {
  if (object.primitive.kind !== "rect_prism") return [];
  const dimensions = object.primitive.dimensionsMm;
  const y = anchorY(object, dimensions.heightMm, 0);
  return [
    { x: 0, y, z: 0 }, { x: dimensions.widthMm, y, z: 0 }, { x: dimensions.widthMm, y, z: dimensions.depthMm }, { x: 0, y, z: dimensions.depthMm },
    { x: 0, y: y + dimensions.heightMm, z: 0 }, { x: dimensions.widthMm, y: y + dimensions.heightMm, z: 0 }, { x: dimensions.widthMm, y: y + dimensions.heightMm, z: dimensions.depthMm }, { x: 0, y: y + dimensions.heightMm, z: dimensions.depthMm },
  ];
}

function profilePoints(object: S6SpatialObject): Point3[] {
  if (object.primitive.kind !== "profile_extrusion") return [];
  const height = object.primitive.heightMm;
  const base = anchorY(object, height, 0);
  const points: Point3[] = [];
  for (const vertex of object.primitive.profile.vertices) points.push({ x: vertex.xMm, y: base, z: vertex.zMm });
  for (const vertex of object.primitive.profile.vertices) points.push({ x: vertex.xMm, y: base + height, z: vertex.zMm });
  return points;
}

function roundPoints(object: S6SpatialObject, facets = 24): Point3[] {
  if (object.primitive.kind !== "round_prism") return [];
  const height = object.primitive.heightMm;
  const base = anchorY(object, height, 0);
  const points: Point3[] = [];
  for (let index = 0; index < facets; index += 1) {
    const angle = (index * Math.PI * 2) / facets;
    points.push({ x: Math.cos(angle) * object.primitive.radiusMm, y: base, z: Math.sin(angle) * object.primitive.radiusMm });
  }
  for (let index = 0; index < facets; index += 1) {
    const angle = (index * Math.PI * 2) / facets;
    points.push({ x: Math.cos(angle) * object.primitive.radiusMm, y: base + height, z: Math.sin(angle) * object.primitive.radiusMm });
  }
  return points;
}

function localPoints(object: S6SpatialObject): Point3[] {
  if (object.primitive.kind === "rect_prism") return rectPoints(object);
  if (object.primitive.kind === "round_prism") return roundPoints(object);
  return profilePoints(object);
}

function worldPoints(object: S6SpatialObject): Point3[] {
  return localPoints(object).map((point) => transformPoint(point, object));
}

function dimensionsFor(object: S6SpatialObject): S6Dimensions {
  if (object.primitive.kind === "rect_prism") return object.primitive.dimensionsMm;
  if (object.primitive.kind === "round_prism") return { widthMm: object.primitive.radiusMm * 2, depthMm: object.primitive.radiusMm * 2, heightMm: object.primitive.heightMm };
  const xs = object.primitive.profile.vertices.map((vertex) => vertex.xMm);
  const zs = object.primitive.profile.vertices.map((vertex) => vertex.zMm);
  return { widthMm: Math.max(...xs) - Math.min(...xs), depthMm: Math.max(...zs) - Math.min(...zs), heightMm: object.primitive.heightMm };
}

function transformedBounds(points: Point3[]): { min: S6Vector3Mm; max: S6Vector3Mm } {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const zs = points.map((point) => point.z);
  return {
    min: { xMm: Math.min(...xs), yMm: Math.min(...ys), zMm: Math.min(...zs) },
    max: { xMm: Math.max(...xs), yMm: Math.max(...ys), zMm: Math.max(...zs) },
  };
}

function finishFor(object: S6SpatialObject, materials: ReadonlyMap<string, S6MaterialFinishRef>): S6MaterialFinishRef | null {
  return object.materialIds.map((id) => materials.get(id)).find((item): item is S6MaterialFinishRef => item !== undefined) ?? null;
}

function hexRgb(hex: string | null): [number, number, number] {
  const value = /^#[0-9a-f]{6}$/iu.test(hex ?? "") ? hex!.slice(1) : "808080";
  return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)];
}

function shade(hex: string | null, amount: number): string {
  const [red, green, blue] = hexRgb(hex);
  const apply = (value: number) => Math.max(0, Math.min(255, roundHalfAwayFromZero(value + (amount >= 0 ? (255 - value) * amount : value * amount))));
  return "#" + [apply(red), apply(green), apply(blue)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function cross(left: Point3, right: Point3): Point3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function dot(left: Point3, right: Point3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function normalize(value: Point3): Point3 {
  const length = Math.sqrt(dot(value, value));
  if (!Number.isFinite(length) || length <= 0) throw new Error("S6_VIEW_RENDER_FAILURE");
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function cameraBasis(camera: S6Camera): CameraBasis {
  const forward = normalize({
    x: camera.targetMm.xMm - camera.positionMm.xMm,
    y: camera.targetMm.yMm - camera.positionMm.yMm,
    z: camera.targetMm.zMm - camera.positionMm.zMm,
  });
  const declaredUp = camera.up === "world-y" ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: -1 };
  const right = normalize(cross(forward, declaredUp));
  const up = normalize(cross(right, forward));
  const focalDistance = Math.sqrt(
    (camera.targetMm.xMm - camera.positionMm.xMm) ** 2 +
    (camera.targetMm.yMm - camera.positionMm.yMm) ** 2 +
    (camera.targetMm.zMm - camera.positionMm.zMm) ** 2,
  );
  if (!Number.isFinite(focalDistance) || focalDistance <= 0) throw new Error("S6_VIEW_RENDER_FAILURE");
  return { forward, right, up, focalDistance };
}

function rawProject(point: Point3, camera: S6Camera, basis: CameraBasis): Point2 {
  const relative = {
    x: point.x - camera.positionMm.xMm,
    y: point.y - camera.positionMm.yMm,
    z: point.z - camera.positionMm.zMm,
  };
  const horizontal = dot(relative, basis.right);
  const vertical = dot(relative, basis.up);
  const depth = dot(relative, basis.forward);
  if (!Number.isFinite(horizontal) || !Number.isFinite(vertical) || !Number.isFinite(depth) || depth <= 0) {
    throw new Error("S6_VIEW_RENDER_FAILURE");
  }
  if (camera.projection === "orthographic") {
    const scale = VIEWPORT_UNITS / (camera.orthoScaleMm ?? 0);
    if (!Number.isFinite(scale) || scale <= 0) throw new Error("S6_VIEW_RENDER_FAILURE");
    return { x: VIEWPORT_UNITS / 2 + horizontal * scale, y: VIEWPORT_UNITS / 2 - vertical * scale, depth };
  }
  const fovRadians = ((camera.fovMd ?? 0) / 1_000) * Math.PI / 180;
  const tangent = Math.tan(fovRadians / 2);
  const halfFrame = basis.focalDistance * tangent + camera.paddingMm;
  if (!Number.isFinite(tangent) || tangent <= 0 || !Number.isFinite(halfFrame) || halfFrame <= 0) {
    throw new Error("S6_VIEW_RENDER_FAILURE");
  }
  const scale = (basis.focalDistance / depth) * (VIEWPORT_UNITS / 2) / halfFrame;
  return { x: VIEWPORT_UNITS / 2 + horizontal * scale, y: VIEWPORT_UNITS / 2 - vertical * scale, depth };
}

function q16(value: number): number {
  const result = roundHalfAwayFromZero(value * S6_RENDER_Q16);
  if (!Number.isSafeInteger(result)) throw new Error("S6_VIEW_RENDER_FAILURE");
  return result;
}

function makeFace(object: S6SpatialObject, points: Point3[], index: number, materialId: string | null, mapped: (point: Point3) => Point2): Face {
  const projectedDepth = points.reduce((total, point) => total + mapped(point).depth, 0) / Math.max(1, points.length);
  return { object, points, depth: roundHalfAwayFromZero(projectedDepth), index, materialId };
}

function facesFor(object: S6SpatialObject, camera: S6Camera, mapped: (point: Point3) => Point2): Face[] {
  const points = worldPoints(object);
  const materialId = object.materialIds[0] ?? null;
  if (object.primitive.kind === "rect_prism") {
    const faces = camera.projection === "orthographic"
      ? [[4, 5, 6, 7]]
      : [[4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    return faces.map((indices, index) => makeFace(object, indices.map((item) => points[item]!), index, materialId, mapped));
  }
  const count = object.primitive.kind === "round_prism" ? 24 : object.primitive.profile.vertices.length;
  if (object.primitive.kind === "round_prism") {
    if (camera.projection === "orthographic") return [makeFace(object, points.slice(0, count), 0, materialId, mapped)];
    const faces: Face[] = [makeFace(object, points.slice(count), 0, materialId, mapped), makeFace(object, points.slice(0, count), 1, materialId, mapped)];
    for (let index = 0; index < count; index += 1) {
      const next = (index + 1) % count;
      faces.push(makeFace(object, [points[index]!, points[next]!, points[count + next]!, points[count + index]!], index + 2, materialId, mapped));
    }
    return faces;
  }
  if (camera.projection === "orthographic") return [makeFace(object, points.slice(0, count), 0, materialId, mapped)];
  const faces: Face[] = [makeFace(object, points.slice(count), 0, materialId, mapped), makeFace(object, points.slice(0, count), 1, materialId, mapped)];
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    faces.push(makeFace(object, [points[index]!, points[next]!, points[count + next]!, points[count + index]!], index + 2, materialId, mapped));
  }
  return faces;
}

function roundedBounds(points: Point3[]): { min: S6Vector3Mm; max: S6Vector3Mm } {
  const result = transformedBounds(points);
  return {
    min: { xMm: roundHalfAwayFromZero(result.min.xMm), yMm: roundHalfAwayFromZero(result.min.yMm), zMm: roundHalfAwayFromZero(result.min.zMm) },
    max: { xMm: roundHalfAwayFromZero(result.max.xMm), yMm: roundHalfAwayFromZero(result.max.yMm), zMm: roundHalfAwayFromZero(result.max.zMm) },
  };
}

function sceneFor(model: S6SpatialModelRecord, camera: S6Camera): S6SceneEvidence {
  const materialIds = Array.from(new Set(model.objects.flatMap((object) => object.materialIds))).sort();
  return {
    schemaVersion: "s6-view-preservation-v1",
    booth: {
      widthMm: model.booth.widthMm,
      depthMm: model.booth.depthMm,
      openSides: model.booth.openSides.slice(),
      coordinateConvention: model.booth.coordinateConvention,
    },
    objects: model.objects.map((object) => ({
      objectId: object.objectId,
      objectType: object.objectType,
      geometryKind: object.primitive.kind,
      geometry: normalizeS6Geometry(object.primitive),
      footprint: deriveS6Footprint(object.primitive),
      boundsMm: dimensionsFor(object),
      transformedBoundsMm: roundedBounds(worldPoints(object)),
      materialIds: object.materialIds.slice().sort(),
      visible: true,
    })),
    overheadObjectIds: model.objects.filter((object) => object.objectType === "overhead_volume").map((object) => object.objectId).sort(),
    materialIds,
    cameraHash: camera.cameraHash,
    sourceS5Fingerprint: model.sourceS5Fingerprint,
    modelHash: hashS6Model(model).modelHash,
    rendererVersion: S6_RENDERER_VERSION,
    externalResourceCount: 0,
    unsafeElementCount: 0,
  };
}

function colorFor(material: S6MaterialFinishRef | null, faceIndex: number): string {
  const base = material?.colorHex ?? "#808080";
  const amount = faceIndex % 3 === 0 ? 0.12 : faceIndex % 3 === 1 ? -0.12 : 0;
  return shade(base, amount);
}

function pointMap(points: Point3[], camera: S6Camera): { map: (point: Point3) => { x: number; y: number; depth: number }; maxX: number; maxY: number } {
  if (points.length === 0) throw new Error("S6_VIEW_RENDER_FAILURE");
  const basis = cameraBasis(camera);
  const projected = points.map((point) => rawProject(point, camera, basis));
  if (projected.some((point) => point.depth < camera.nearMm || point.depth > camera.farMm)) {
    throw new Error("S6_VIEW_RENDER_FAILURE");
  }
  const map = (point: Point3): { x: number; y: number; depth: number } => {
    const value = rawProject(point, camera, basis);
    return {
      x: q16(value.x),
      y: q16(value.y),
      depth: q16(value.depth),
    };
  };
  return { map, maxX: q16(VIEWPORT_UNITS), maxY: q16(VIEWPORT_UNITS) };
}

function faceSvg(face: Face, mapped: ReturnType<typeof pointMap>["map"], materials: ReadonlyMap<string, S6MaterialFinishRef>): string {
  const material = face.materialId ? materials.get(face.materialId) ?? null : null;
  const points = face.points.map((point) => {
    const projected = mapped(point);
    return projected.x + "," + projected.y;
  }).join(" ");
  const materialId = escapeXml(face.materialId ?? "");
  const finishKind = escapeXml(material?.finishKind ?? "solid_color");
  return "<polygon data-s6-object-id=\"" + escapeXml(face.object.objectId) +
    "\" data-object-id=\"" + escapeXml(face.object.objectId) +
    "\" data-object-type=\"" + escapeXml(face.object.objectType) +
    "\" data-geometry-kind=\"" + escapeXml(face.object.primitive.kind) +
    "\" data-material-id=\"" + materialId +
    "\" data-finish-kind=\"" + finishKind +
    "\" points=\"" + points +
    "\" fill=\"" + colorFor(material, face.index) +
    "\" fill-opacity=\"" + (material?.finishKind === "glass_like" ? "0.55" : material?.finishKind === "fabric_like" ? "0.82" : "1") +
    "\" stroke=\"#20242a\" stroke-width=\"1\" />";
}

function labelSvg(object: S6SpatialObject, mapped: ReturnType<typeof pointMap>["map"], camera: S6Camera): string {
  if (camera.projection !== "orthographic") return "";
  const first = worldPoints(object)[0];
  if (!first) return "";
  const projected = mapped(first);
  return "<text data-s6-object-label=\"" + escapeXml(object.objectId) + "\" x=\"" + projected.x + "\" y=\"" + projected.y + "\" fill=\"#20242a\">" + escapeXml(object.label) + "</text>";
}

export function renderS6View(model: S6SpatialModelRecord, camera: S6Camera): S6RenderedView {
  if (model.status === "accepted_current" && (model.designFormReview.status !== "complete" || !model.designFormReview.acceptedByUser || model.designFormReview.unresolvedUnknownIds.length > 0)) {
    throw new Error("S6_DESIGN_FORM_UNREVIEWED");
  }
  const allPoints = model.objects.flatMap((object) => worldPoints(object));
  const frame = pointMap(allPoints, camera);
  const materials = new Map(model.materials.map((material) => [material.materialId, material]));
  const faces = model.objects.flatMap((object) => facesFor(object, camera, frame.map)).sort((left, right) => right.depth - left.depth || (left.object.objectId < right.object.objectId ? -1 : left.object.objectId > right.object.objectId ? 1 : left.index - right.index));
  const marker = model.status === "accepted_current" ? "" : "<text data-draft-marker=\"true\" x=\"" + q16(5) + "\" y=\"" + q16(5) + "\" fill=\"#9a4d00\">DRAFT - DESIGN FORM REVIEW REQUIRED</text>";
  const body = faces.map((face) => faceSvg(face, frame.map, materials)).join("") +
    model.objects.map((object) => labelSvg(object, frame.map, camera)).join("") + marker;
  const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" data-view-id=\"" + camera.viewId +
    "\" data-renderer-version=\"" + S6_RENDERER_VERSION +
    "\" viewBox=\"0 0 " + frame.maxX + " " + frame.maxY + "\"><title>S6 spatial view " + escapeXml(camera.viewId) +
    "</title>" + body + "</svg>";
  const svgBytes = new TextEncoder().encode(svg);
  if (svgBytes.byteLength > S6_MAX_VIEW_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
  const sceneEvidence = sceneFor(model, camera);
  const sceneHash = sha256(canonicalS6Json(sceneEvidence));
  return {
    viewId: camera.viewId,
    cameraHash: camera.cameraHash,
    sceneHash,
    svgBytes,
    outputSha256: sha256(svgBytes),
    outputByteSize: svgBytes.byteLength,
    projectedBoundsQ16: { minX: 0, minY: 0, maxX: frame.maxX, maxY: frame.maxY },
    visibleObjectIds: model.objects.map((object) => object.objectId),
    materialIds: Array.from(new Set(model.objects.flatMap((object) => object.materialIds))).sort(),
    sceneEvidence,
  };
}
