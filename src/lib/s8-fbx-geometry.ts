import { AppError, type S6GeometryPrimitive, type S6ProfileVertex } from "./types";
import { S8_LIMITS, S8_PRECISION, s8Basis } from "./s8-fbx-profile";

export type S8Vec3 = readonly [number, number, number];
export type S8Triangle = readonly [number, number, number];
export type S8Mesh = {
  verticesMm: S8Vec3[];
  triangles: S8Triangle[];
  cornerNormals: S8Vec3[];
  roundSegments: number | null;
  analyticSagittaMm: number | null;
};

const EPS = 1e-9;

function fail(code: string, field = "geometry"): never {
  throw new AppError(422, code, [{ field, code }]);
}

function finitePositive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000_000) fail("S8_GEOMETRY_INVALID", field);
  return value;
}

function area2(points: readonly S6ProfileVertex[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a.xMm * b.zMm - a.zMm * b.xMm;
  }
  return area;
}

function cross2(a: S6ProfileVertex, b: S6ProfileVertex, c: S6ProfileVertex): number {
  return (b.xMm - a.xMm) * (c.zMm - a.zMm) - (b.zMm - a.zMm) * (c.xMm - a.xMm);
}

function pointInTriangle(p: S6ProfileVertex, a: S6ProfileVertex, b: S6ProfileVertex, c: S6ProfileVertex): boolean {
  const ab = cross2(a, b, p);
  const bc = cross2(b, c, p);
  const ca = cross2(c, a, p);
  return ab >= -EPS && bc >= -EPS && ca >= -EPS;
}

function segmentsIntersect(a: S6ProfileVertex, b: S6ProfileVertex, c: S6ProfileVertex, d: S6ProfileVertex): boolean {
  const abC = cross2(a, b, c);
  const abD = cross2(a, b, d);
  const cdA = cross2(c, d, a);
  const cdB = cross2(c, d, b);
  return abC * abD < -EPS && cdA * cdB < -EPS;
}

export function validateS8Profile(input: readonly S6ProfileVertex[], maximum: number = S8_LIMITS.profileVertices): S6ProfileVertex[] {
  if (input.length < 3 || input.length > maximum) fail("S8_PROFILE_INVALID", "profile.vertices");
  const points = input.map((point, index) => {
    if (!Number.isFinite(point.xMm) || !Number.isFinite(point.zMm)) fail("S8_PROFILE_INVALID", `profile.vertices.${index}`);
    return { xMm: point.xMm, zMm: point.zMm };
  });
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    if (Math.hypot(b.xMm - a.xMm, b.zMm - a.zMm) <= EPS) fail("S8_PROFILE_INVALID", "profile.vertices");
    for (let j = i + 1; j < points.length; j += 1) {
      if (j === i || j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      const c = points[j]!;
      const d = points[(j + 1) % points.length]!;
      if (segmentsIntersect(a, b, c, d)) fail("S8_PROFILE_SELF_INTERSECTION", "profile.vertices");
    }
  }
  const signed = area2(points);
  if (Math.abs(signed) <= EPS) fail("S8_PROFILE_INVALID", "profile.vertices");
  return signed > 0 ? points : points.reverse();
}

export function triangulateS8Profile(input: readonly S6ProfileVertex[], maximum: number = S8_LIMITS.profileVertices): S8Triangle[] {
  const points = validateS8Profile(input, maximum);
  const remaining = points.map((_, index) => index);
  const triangles: S8Triangle[] = [];
  while (remaining.length > 3) {
    let clipped = false;
    for (let offset = 0; offset < remaining.length; offset += 1) {
      const currentIndex = remaining[(offset + 1) % remaining.length]!;
      const previousIndex = remaining[offset]!;
      const nextIndex = remaining[(offset + 2) % remaining.length]!;
      const a = points[previousIndex]!;
      const b = points[currentIndex]!;
      const c = points[nextIndex]!;
      if (cross2(a, b, c) <= EPS) continue;
      if (remaining.some((candidate) => candidate !== previousIndex && candidate !== currentIndex && candidate !== nextIndex && pointInTriangle(points[candidate]!, a, b, c))) continue;
      triangles.push([previousIndex, currentIndex, nextIndex]);
      remaining.splice((offset + 1) % remaining.length, 1);
      clipped = true;
      break;
    }
    if (!clipped) fail("S8_PROFILE_TRIANGULATION_FAILED", "profile.vertices");
  }
  triangles.push([remaining[0]!, remaining[1]!, remaining[2]!]);
  return triangles;
}

export function s8RoundSegments(radiusMm: number): number {
  finitePositive(radiusMm, "radiusMm");
  const raw = Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - S8_PRECISION.roundSagittaMm / radiusMm)));
  const even = Math.max(4, raw % 2 === 0 ? raw : raw + 1);
  if (even > S8_LIMITS.roundSegments) fail("S8_ROUND_SEGMENT_LIMIT", "radiusMm");
  return even;
}

export function s8RoundSagitta(radiusMm: number, segments: number): number {
  return radiusMm * (1 - Math.cos(Math.PI / segments));
}

function normalize(vector: S8Vec3): S8Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length <= EPS) fail("S8_TRIANGLE_DEGENERATE");
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function triangleNormal(vertices: readonly S8Vec3[], triangle: S8Triangle): S8Vec3 {
  const a = vertices[triangle[0]]!;
  const b = vertices[triangle[1]]!;
  const c = vertices[triangle[2]]!;
  const ab: S8Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: S8Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return normalize([ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]);
}

function extrude(profileInput: readonly S6ProfileVertex[], heightMm: number, anchor: "floor" | "center", roundSegments: number | null): S8Mesh {
  const maximum = roundSegments ?? S8_LIMITS.profileVertices;
  const profile = validateS8Profile(profileInput, maximum);
  const cap = triangulateS8Profile(profile, maximum);
  const bottomY = anchor === "floor" ? 0 : -heightMm / 2;
  const topY = bottomY + heightMm;
  const s6Vertices: S8Vec3[] = [
    ...profile.map((point) => [point.xMm, bottomY, point.zMm] as const),
    ...profile.map((point) => [point.xMm, topY, point.zMm] as const),
  ];
  const verticesMm = s6Vertices.map(s8Basis);
  const n = profile.length;
  const triangles: S8Triangle[] = [];
  for (const [a, b, c] of cap) {
    triangles.push([a, b, c]);
    triangles.push([n + a, n + c, n + b]);
  }
  for (let i = 0; i < n; i += 1) {
    const next = (i + 1) % n;
    triangles.push([i, n + next, next]);
    triangles.push([i, n + i, n + next]);
  }
  const cornerNormals = triangles.flatMap((triangle) => {
    const normal = triangleNormal(verticesMm, triangle);
    return [normal, normal, normal];
  });
  const mesh: S8Mesh = {
    verticesMm,
    triangles,
    cornerNormals,
    roundSegments,
    analyticSagittaMm: roundSegments === null ? null : s8RoundSagitta(Math.hypot(profile[0]!.xMm, profile[0]!.zMm), roundSegments),
  };
  assertS8Mesh(mesh);
  return mesh;
}

export function buildS8Mesh(geometry: S6GeometryPrimitive): S8Mesh {
  if (geometry.kind === "rect_prism") {
    const width = finitePositive(geometry.dimensionsMm.widthMm, "dimensionsMm.widthMm");
    const depth = finitePositive(geometry.dimensionsMm.depthMm, "dimensionsMm.depthMm");
    const height = finitePositive(geometry.dimensionsMm.heightMm, "dimensionsMm.heightMm");
    return extrude([
      { xMm: -width / 2, zMm: -depth / 2 },
      { xMm: width / 2, zMm: -depth / 2 },
      { xMm: width / 2, zMm: depth / 2 },
      { xMm: -width / 2, zMm: depth / 2 },
    ], height, geometry.localAnchor, null);
  }
  if (geometry.kind === "round_prism") {
    const radius = finitePositive(geometry.radiusMm, "radiusMm");
    const height = finitePositive(geometry.heightMm, "heightMm");
    const segments = s8RoundSegments(radius);
    const profile = Array.from({ length: segments }, (_, index) => {
      const angle = index * Math.PI * 2 / segments;
      return { xMm: radius * Math.cos(angle), zMm: radius * Math.sin(angle) };
    });
    return extrude(profile, height, geometry.localAnchor, segments);
  }
  return extrude(geometry.profile.vertices, finitePositive(geometry.heightMm, "heightMm"), geometry.localAnchor, null);
}

export function assertS8Mesh(mesh: S8Mesh): void {
  if (mesh.verticesMm.length === 0 || mesh.triangles.length === 0 || mesh.cornerNormals.length !== mesh.triangles.length * 3) fail("S8_MESH_INVALID");
  if (mesh.verticesMm.length > S8_LIMITS.controlPoints || mesh.triangles.length > S8_LIMITS.triangles) fail("S8_RESOURCE_LIMIT");
  for (const [index, vertex] of mesh.verticesMm.entries()) {
    if (vertex.length !== 3 || vertex.some((value) => !Number.isFinite(value))) fail("S8_VERTEX_INVALID", `vertices.${index}`);
  }
  const edges = new Map<string, [number, number][] >();
  const adjacency = new Map<number, Set<number>>();
  for (const [index, triangle] of mesh.triangles.entries()) {
    if (new Set(triangle).size !== 3 || triangle.some((value) => !Number.isInteger(value) || value < 0 || value >= mesh.verticesMm.length)) fail("S8_TRIANGLE_INDEX_INVALID", `triangles.${index}`);
    const expectedNormal = triangleNormal(mesh.verticesMm, triangle);
    for (let corner = 0; corner < 3; corner += 1) {
      const normal = mesh.cornerNormals[index * 3 + corner]!;
      const dot = expectedNormal[0] * normal[0] + expectedNormal[1] * normal[1] + expectedNormal[2] * normal[2];
      if (dot < 1 - 1e-8) fail(dot < 0 ? "S8_NORMAL_FLIPPED" : "S8_NORMAL_MISMATCH", `cornerNormals.${index * 3 + corner}`);
    }
    for (const [from, to] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]] as const) {
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      const list = edges.get(key) ?? [];
      list.push([from, to]);
      edges.set(key, list);
      const fromSet = adjacency.get(from) ?? new Set<number>();
      fromSet.add(to);
      adjacency.set(from, fromSet);
      const toSet = adjacency.get(to) ?? new Set<number>();
      toSet.add(from);
      adjacency.set(to, toSet);
    }
  }
  for (const incidences of edges.values()) {
    if (incidences.length !== 2 || incidences[0]![0] !== incidences[1]![1] || incidences[0]![1] !== incidences[1]![0]) fail("S8_MESH_NOT_ORIENTABLE_MANIFOLD");
  }
  const visited = new Set<number>();
  const pending = [0];
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) pending.push(next);
  }
  if (visited.size !== mesh.verticesMm.length) fail("S8_MESH_NOT_CONNECTED");
  for (const [index, normal] of mesh.cornerNormals.entries()) {
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-8) fail("S8_NORMAL_INVALID", `cornerNormals.${index}`);
  }
}
