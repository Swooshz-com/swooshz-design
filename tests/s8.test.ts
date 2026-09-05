import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AppError,
  type Project,
  type S6GeometryPrimitive,
  type S6ToS7Handoff,
  type S8MaxPayloadV1,
  type S8SourceStampV1,
  type Timestamp,
  type UUID,
} from "../src/lib/types";
import { emptyStoreState, JsonRepository, PrivateObjectStore } from "../src/lib/store";
import { S7CadService } from "../src/lib/s7-cad";
import { handleApiRequest, type ApiRequestDependencies } from "../src/lib/api";
import {
  S8_CONSTRUCTION,
  S8_MAX_FACES_PER_OBJECT,
  S8_MAX_ROUND_SEGMENTS,
  S8_MAX_VERTICES_PER_OBJECT,
  buildS8Payload,
  canonicalS8Json,
  sourceStampDigest,
  sourceStampFromParts,
} from "../src/lib/s8-payload";
import {
  buildS8IndependentReadback,
  buildS8Scene,
  buildS8SemanticManifest,
  compareS8SemanticManifest,
  inverseS8MaxMatrix,
  multiplyS8MaxMatrices,
  s8MaxMatrixFromS6Transform,
  triangulateS8Profile,
} from "../src/lib/s8-semantic";
import { S8MaxService, type S8PublicationPhase } from "../src/lib/s8";
import { classifyS8ProviderFailure, createMockS8MaxProvider, MockOssV2Transfer, S8MaxProviderError, type S8MaxProvider } from "../src/lib/s8-max-provider";
import { getS8Collections, validateS8Graph } from "../src/lib/s8-persistence";
import { jcs, sha256 } from "../src/lib/utils";

const PROJECT_ID = "20000000-0000-4000-8000-000000000001" as UUID;
const REVISION_ID = "30000000-0000-4000-8000-000000000001" as UUID;
const VALIDATION_ID = "30000000-0000-4000-8000-000000000002" as UUID;
const APPROVAL_ID = "30000000-0000-4000-8000-000000000003" as UUID;
const HASH = "a".repeat(64);
const SECOND_HASH = "b".repeat(64);

function project(): Project {
  return {
    projectId: PROJECT_ID,
    name: "S8 fixture",
    status: "geometry_ready",
    boothGeometry: null,
    briefAssetId: null,
    briefDraftId: null,
    confirmedBriefVersionId: null,
    activeGenerationSetId: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

function material(materialId: string, finishKind: "metal_like" | "glass_like" | "unknown" = "metal_like", colorHex: string | null = "#112233") {
  return {
    materialId,
    label: materialId,
    finishKind,
    colorHex,
    source: "confirmed_project_input",
    sourceAssetId: null,
    sourceAssetSha256: null,
    notes: null,
    provenance: { kind: "confirmed_project_input", sourceRef: "fixture", sourceFingerprint: HASH, acceptedByUser: true, note: null },
  };
}

function objectValue(options: Record<string, unknown> = {}): Record<string, unknown> {
  const geometry = (options.geometry ?? { kind: "rect_prism", dimensionsMm: { widthMm: 1000, depthMm: 500, heightMm: 900 }, geometryState: "exact", localAnchor: "floor" }) as S6GeometryPrimitive;
  const dimensions = geometry.kind === "rect_prism"
    ? geometry.dimensionsMm
    : geometry.kind === "round_prism"
      ? { widthMm: geometry.radiusMm * 2, depthMm: geometry.radiusMm * 2, heightMm: geometry.heightMm }
      : { widthMm: 400, depthMm: 200, heightMm: geometry.heightMm };
  const footprint = geometry.kind === "rect_prism"
    ? { kind: "rectangle", widthMm: dimensions.widthMm, depthMm: dimensions.depthMm }
    : geometry.kind === "round_prism"
      ? { kind: "circle", radiusMm: geometry.radiusMm }
      : { kind: "polygon", vertices: geometry.profile.vertices };
  return {
    objectId: "object-1",
    identityKey: "object-1",
    parentObjectId: null,
    objectType: "box",
    role: "furniture",
    geometry,
    footprint,
    transform: { positionMm: { xMm: 100, yMm: 200, zMm: 300 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } },
    boundsMm: dimensions,
    zoneIds: [],
    requirementIds: [],
    materialIds: ["mat-metal"],
    provenance: { kind: "confirmed_project_input", sourceRef: "fixture", sourceFingerprint: HASH, acceptedByUser: true, note: null },
    unknownIds: [],
    ...options,
  };
}

function fixtureHandoff(overrides: { objects?: Record<string, unknown>[]; revisionId?: UUID; revisionHash?: string } = {}): S6ToS7Handoff {
  const objects = overrides.objects ?? [objectValue()];
  return {
    schemaVersion: "s6-to-s7-handoff-v1",
    projectId: PROJECT_ID,
    acceptedRevisionId: overrides.revisionId ?? REVISION_ID,
    acceptedRevisionHash: overrides.revisionHash ?? HASH,
    sourceS5Fingerprint: HASH,
    spatialSchemaVersion: "s6-spatial-model-v1",
    units: "millimetres",
    coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" },
    booth: { widthMm: 6000, depthMm: 3000, openSides: ["north", "east"], maxHeightMm: 3000, heightState: "known" },
    objects,
    hierarchy: objects.map((item) => ({ objectId: String(item.objectId), parentObjectId: (item.parentObjectId ?? null) as string | null })),
    zones: [],
    requirements: [],
    materials: [material("mat-metal"), material("mat-glass", "glass_like", "#445566"), material("mat-unknown", "unknown", null)],
    assumptions: [],
    unknowns: [],
    validationReceipt: { receiptId: VALIDATION_ID, validationHash: HASH, outcome: "pass" },
    eligibility: { currentAccepted: true, sourceCurrent: true, stale: false },
  } as unknown as S6ToS7Handoff;
}

function stampFor(handoff: S6ToS7Handoff, options: Partial<{ s7ArtifactId: UUID; s7ArtifactHash: string; s7ArtifactSize: number; s7ManifestId: UUID; s7ManifestHash: string; s7ReadbackReceiptId: UUID; s7ReadbackReceiptHash: string }> = {}): S8SourceStampV1 {
  return sourceStampFromParts({
    projectId: PROJECT_ID,
    s6RevisionId: handoff.acceptedRevisionId,
    s6RevisionHash: handoff.acceptedRevisionHash,
    sourceS5Fingerprint: handoff.sourceS5Fingerprint,
    sourceS5ApprovalEventId: APPROVAL_ID,
    sourceS5Generation: 7,
    s6ValidationReceiptId: handoff.validationReceipt.receiptId,
    s6ValidationReceiptHash: handoff.validationReceipt.validationHash,
    s6Handoff: handoff,
    s7ArtifactId: options.s7ArtifactId ?? "40000000-0000-4000-8000-000000000001" as UUID,
    s7ArtifactHash: options.s7ArtifactHash ?? HASH,
    s7ArtifactSize: options.s7ArtifactSize ?? 42,
    s7ManifestId: options.s7ManifestId ?? "40000000-0000-4000-8000-000000000002" as UUID,
    s7ManifestHash: options.s7ManifestHash ?? HASH,
    s7ReadbackReceiptId: options.s7ReadbackReceiptId ?? "40000000-0000-4000-8000-000000000003" as UUID,
    s7ReadbackReceiptHash: options.s7ReadbackReceiptHash ?? HASH,
  });
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : error instanceof Error ? error.message.split(":", 1)[0]! : String(error);
}

function sourceRevision(handoff: S6ToS7Handoff): Record<string, unknown> {
  return {
    modelRevisionId: handoff.acceptedRevisionId,
    projectId: PROJECT_ID,
    sourceS5Fingerprint: handoff.sourceS5Fingerprint,
    sourceS5ApprovalEventId: APPROVAL_ID,
    sourceS5ApprovalGeneration: 7,
    status: "accepted_current",
    modelHash: handoff.acceptedRevisionHash,
  };
}

function makeContext(options: { provider?: S8MaxProvider; handoff?: S6ToS7Handoff; s7Failure?: boolean; clock?: () => Timestamp; onPublicationPhase?: (phase: S8PublicationPhase) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "s8-g3-"));
  const repository = new JsonRepository(root);
  repository.transact((state) => state.projects.push(project()));
  const objects = new PrivateObjectStore(join(root, "objects"));
  let current = options.handoff ?? fixtureHandoff();
  const s6 = {
    getS7Handoff: () => structuredClone(current),
    getRevision: (_projectId: UUID, revisionId: UUID) => ({ revision: sourceRevision(current), validation: { receiptId: current.validationReceipt.receiptId, projectId: PROJECT_ID, revisionId, revisionHash: current.acceptedRevisionHash, validationHash: current.validationReceipt.validationHash, outcome: current.validationReceipt.outcome }, views: [] }),
  } as never;
  const s7 = new S7CadService({ repository, objects, s6 });
  if (!options.s7Failure) s7.createExport(PROJECT_ID, "s7-fixture-key");
  const service = new S8MaxService({ repository, objects, s6, s7, provider: options.provider ?? createMockS8MaxProvider(), ownerProcessId: "s8-test-owner", clock: options.clock, onPublicationPhase: options.onPublicationPhase ? (phase) => options.onPublicationPhase?.(phase) : undefined });
  return { repository, objects, s6, s7, service, move(next: S6ToS7Handoff) { current = next; } };
}

test("S8 payload stamp and canonical bytes are deterministic and bind the exact S6 handoff", () => {
  const handoff = fixtureHandoff();
  const stamp = stampFor(handoff);
  const first = buildS8Payload(stamp, handoff);
  const second = buildS8Payload(structuredClone(stamp), structuredClone(handoff));
  assert.equal(first.canonicalJson, second.canonicalJson);
  assert.equal(first.sha256, sha256(first.bytes));
  assert.equal(first.byteSize, first.bytes.length);
  assert.equal(sourceStampDigest(stamp), sha256(Buffer.from(jcs(stamp), "utf8")));
  assert.equal(first.payload.schemaVersion, "s8.max.payload-v1");
  assert.deepEqual(first.payload.construction, S8_CONSTRUCTION);
  assert.deepEqual(first.payload.s6Handoff, handoff);
  assert.throws(() => buildS8Payload({ ...stamp, s6HandoffDigest: SECOND_HASH }, handoff), /S8_PAYLOAD_INVALID|S7_CROSS_OUTPUT_MISMATCH/u);
});

test("every accepted geometry family builds deterministic editable-poly semantics with winding and limits", () => {
  const profile = { kind: "profile_extrusion", profile: { winding: "ccw-from-positive-y-v1", vertices: [{ xMm: 0, zMm: 0 }, { xMm: 0, zMm: 200 }, { xMm: 400, zMm: 200 }, { xMm: 400, zMm: 0 }] }, heightMm: 2400, geometryState: "exact", localAnchor: "floor" };
  const objects = [
    objectValue({ objectId: "floor", identityKey: "floor", objectType: "floor_footprint", role: "booth_floor", geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 6000, depthMm: 3000, heightMm: 100 }, geometryState: "exact", localAnchor: "floor" }, boundsMm: { widthMm: 6000, depthMm: 3000, heightMm: 100 }, materialIds: [] }),
    objectValue({ objectId: "wall", identityKey: "wall", objectType: "wall", role: "booth_wall", geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 100, depthMm: 3000, heightMm: 2800 }, geometryState: "exact", localAnchor: "floor" }, boundsMm: { widthMm: 100, depthMm: 3000, heightMm: 2800 }, parentObjectId: "floor" }),
    objectValue({ objectId: "partition", identityKey: "partition", objectType: "partition", role: "booth_partition", geometry: profile, boundsMm: { widthMm: 400, depthMm: 200, heightMm: 2400 }, parentObjectId: "wall" }),
    objectValue({ objectId: "counter", identityKey: "counter", objectType: "counter", role: "furniture", geometry: { kind: "round_prism", radiusMm: 400, heightMm: 1000, geometryState: "exact", localAnchor: "floor" }, boundsMm: { widthMm: 800, depthMm: 800, heightMm: 1000 }, parentObjectId: "floor", transform: { positionMm: { xMm: 1000, yMm: 0, zMm: 500 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } } }),
    objectValue({ objectId: "screen", identityKey: "screen", objectType: "screen", role: "screen", geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 1200, depthMm: 100, heightMm: 1600 }, geometryState: "exact", localAnchor: "floor" }, boundsMm: { widthMm: 1200, depthMm: 100, heightMm: 1600 }, parentObjectId: "counter", materialIds: ["mat-glass"] }),
    objectValue({ objectId: "table", identityKey: "table", objectType: "table", role: "furniture", geometry: { kind: "round_prism", radiusMm: 500, heightMm: 750, geometryState: "exact", localAnchor: "center" }, boundsMm: { widthMm: 1000, depthMm: 1000, heightMm: 750 }, parentObjectId: "floor", transform: { positionMm: { xMm: 3000, yMm: 800, zMm: 1500 }, rotationMd: { xMd: 30000, yMd: 45000, zMd: 60000 } } }),
    objectValue({ objectId: "zone", identityKey: "zone", objectType: "zone_region", role: "zone", geometry: profile, boundsMm: { widthMm: 400, depthMm: 200, heightMm: 2400 }, parentObjectId: "floor" }),
    objectValue({ objectId: "overhead", identityKey: "overhead", objectType: "overhead_volume", role: "overhead", geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 2000, depthMm: 1000, heightMm: 300 }, geometryState: "exact", localAnchor: "center" }, boundsMm: { widthMm: 2000, depthMm: 1000, heightMm: 300 }, parentObjectId: "floor", materialIds: ["mat-unknown"] }),
  ];
  const handoff = fixtureHandoff({ objects });
  const payload = buildS8Payload(stampFor(handoff), handoff);
  const scene = buildS8Scene(payload.payload, "50000000-0000-4000-8000-000000000001" as UUID, payload.sha256);
  assert.equal(scene.objectCount, 8);
  assert.equal(scene.nodes.find((node) => node.objectId === "counter")!.mesh!.vertices.length, 2 * S8_MAX_ROUND_SEGMENTS + 2);
  assert.equal(scene.nodes.find((node) => node.objectId === "counter")!.mesh!.faces.length, 3 * S8_MAX_ROUND_SEGMENTS);
  assert.equal(scene.nodes.find((node) => node.objectId === "partition")!.mesh!.faces.length, 8);
  assert.ok(scene.nodes.every((node) => (node.mesh?.vertices.length ?? 0) <= S8_MAX_VERTICES_PER_OBJECT && (node.mesh?.faces.length ?? 0) <= S8_MAX_FACES_PER_OBJECT));
  const glass = scene.nodes.find((node) => node.objectId === "screen")!.material!;
  assert.equal(glass.nativeClass, "PhysicalMaterial");
  assert.equal(glass.transparency, 0.25);
  assert.ok(glass.degradationCodes.includes("S8_MATERIAL_TRANSPARENCY_UNSPECIFIED"));
  const unknown = scene.nodes.find((node) => node.objectId === "overhead")!.material!;
  assert.equal(unknown.metalness, 0);
  assert.ok(unknown.degradationCodes.includes("S8_MATERIAL_FINISH_UNSPECIFIED"));
  assert.ok(unknown.degradationCodes.includes("S8_MATERIAL_COLOR_UNSPECIFIED"));
  for (const node of scene.nodes) {
    for (const face of node.mesh!.faces) {
      const a = node.mesh!.vertices[face[0] - 1]!;
      const b = node.mesh!.vertices[face[1] - 1]!;
      const c = node.mesh!.vertices[face[2] - 1]!;
      const cross = { x: (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y), y: (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z), z: (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) };
      assert.ok(Math.hypot(cross.x, cross.y, cross.z) > 0);
    }
  }
  assert.deepEqual(scene.nodes.map((node) => node.parentObjectId), [null, "floor", "floor", "floor", "floor", "floor", "wall", "counter"]);
});

test("G3 repair regression: locked final topology keeps quads for solids and sides", () => {
  const handoff = fixtureHandoff();
  const rectanglePayload = buildS8Payload(stampFor(handoff), handoff);
  const rectangle = buildS8Scene(rectanglePayload.payload, "50000000-0000-4000-8000-000000000001" as UUID, rectanglePayload.sha256).nodes[0]!;
  assert.deepEqual(rectangle.mesh!.faces, [[1, 2, 3, 4], [5, 8, 7, 6], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 8, 4], [4, 8, 5, 1]]);

  const roundGeometry = { kind: "round_prism", radiusMm: 400, heightMm: 1000, geometryState: "exact", localAnchor: "floor" } as const;
  const roundHandoff = fixtureHandoff({ objects: [objectValue({ geometry: roundGeometry, boundsMm: { widthMm: 800, depthMm: 800, heightMm: 1000 } })] });
  const roundPayload = buildS8Payload(stampFor(roundHandoff), roundHandoff);
  const round = buildS8Scene(roundPayload.payload, "50000000-0000-4000-8000-000000000002" as UUID, roundPayload.sha256).nodes[0]!;
  assert.equal(round.mesh!.faces.length, 3 * S8_MAX_ROUND_SEGMENTS);
  assert.equal(round.mesh!.faces.filter((face) => face.length === 4).length, S8_MAX_ROUND_SEGMENTS);
  assert.equal(round.mesh!.faces.filter((face) => face.length === 3).length, 2 * S8_MAX_ROUND_SEGMENTS);

  const profileGeometry = { kind: "profile_extrusion", profile: { winding: "ccw-from-positive-y-v1", vertices: [{ xMm: 0, zMm: 0 }, { xMm: 0, zMm: 200 }, { xMm: 400, zMm: 200 }, { xMm: 400, zMm: 0 }] }, heightMm: 2400, geometryState: "exact", localAnchor: "floor" } as const;
  const profileHandoff = fixtureHandoff({ objects: [objectValue({ geometry: profileGeometry, boundsMm: { widthMm: 400, depthMm: 200, heightMm: 2400 } })] });
  const profilePayload = buildS8Payload(stampFor(profileHandoff), profileHandoff);
  const profile = buildS8Scene(profilePayload.payload, "50000000-0000-4000-8000-000000000003" as UUID, profilePayload.sha256).nodes[0]!;
  assert.equal(profile.mesh!.faces.length, 2 * (profileGeometry.profile.vertices.length - 2) + profileGeometry.profile.vertices.length);
  assert.equal(profile.mesh!.faces.filter((face) => face.length === 3).length, 2 * (profileGeometry.profile.vertices.length - 2));
  assert.equal(profile.mesh!.faces.filter((face) => face.length === 4).length, profileGeometry.profile.vertices.length);
});

test("concave profiles use deterministic first-valid-ear clipping and fail closed for self-intersection", () => {
  const concave = { winding: "ccw-from-positive-y-v1" as const, vertices: [{ xMm: 0, zMm: 0 }, { xMm: 0, zMm: 400 }, { xMm: 100, zMm: 400 }, { xMm: 100, zMm: 100 }, { xMm: 400, zMm: 100 }, { xMm: 400, zMm: 0 }] };
  const first = triangulateS8Profile(concave);
  const second = triangulateS8Profile(structuredClone(concave));
  assert.deepEqual(first, second);
  assert.equal(first.length, concave.vertices.length - 2);
  const crossed = { winding: "ccw-from-positive-y-v1" as const, vertices: [{ xMm: 0, zMm: 0 }, { xMm: 400, zMm: 400 }, { xMm: 0, zMm: 400 }, { xMm: 400, zMm: 0 }] };
  assert.throws(() => triangulateS8Profile(crossed), /S8_PROFILE_TRIANGULATION_FAILED/u);
});

test("Max basis mapping, mixed rotations, nested transforms, and inverse are deterministic", () => {
  const parent = s8MaxMatrixFromS6Transform({ positionMm: { xMm: 100, yMm: 20, zMm: 50 }, rotationMd: { xMd: 0, yMd: 0, zMd: 90000 } });
  const child = s8MaxMatrixFromS6Transform({ positionMm: { xMm: 10, yMm: 0, zMm: 0 }, rotationMd: { xMd: 30000, yMd: 45000, zMd: 60000 } });
  const world = multiplyS8MaxMatrices(child, parent);
  const restored = multiplyS8MaxMatrices(world, inverseS8MaxMatrix(parent));
  assert.ok(Math.abs(restored.translation.x - child.translation.x) <= 1e-6);
  assert.ok(Math.abs(restored.translation.y - child.translation.y) <= 1e-6);
  assert.ok(Math.abs(restored.translation.z - child.translation.z) <= 1e-6);
  for (let row = 0; row < 3; row += 1) for (const axis of ["x", "y", "z"] as const) assert.ok(Math.abs(restored.rows[row]![axis] - child.rows[row]![axis]) <= 1e-6);
  assert.deepEqual(s8MaxMatrixFromS6Transform({ positionMm: { xMm: 0, yMm: 0, zMm: 0 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } }).rows, [{ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: -1, z: 0 }]);
  const parentTransform = { positionMm: { xMm: 140, yMm: 35, zMm: 80 }, rotationMd: { xMd: 15000, yMd: 25000, zMd: 90000 } };
  const childTransform = { positionMm: { xMm: 25, yMm: 40, zMm: -15 }, rotationMd: { xMd: 30000, yMd: 45000, zMd: 60000 } };
  const nested = fixtureHandoff({ objects: [
    objectValue({ objectId: "nested-parent", identityKey: "nested-parent", transform: parentTransform }),
    objectValue({ objectId: "nested-child", identityKey: "nested-child", parentObjectId: "nested-parent", transform: childTransform }),
  ] });
  const nestedPayload = buildS8Payload(stampFor(nested), nested);
  const nestedScene = buildS8Scene(nestedPayload.payload, "50000000-0000-4000-8000-000000000003" as UUID, nestedPayload.sha256);
  const nestedParent = nestedScene.nodes.find((node) => node.objectId === "nested-parent")!;
  const nestedChild = nestedScene.nodes.find((node) => node.objectId === "nested-child")!;
  const nestedLocal = s8MaxMatrixFromS6Transform(childTransform);
  for (let row = 0; row < 3; row += 1) for (const axis of ["x", "y", "z"] as const) assert.ok(Math.abs(nestedChild.localTransform.rows[row]![axis] - nestedLocal.rows[row]![axis]) <= 1e-6);
  for (const axis of ["x", "y", "z"] as const) assert.ok(Math.abs(nestedChild.localTransform.translation[axis] - nestedLocal.translation[axis]) <= 1e-6);
  assert.notDeepEqual(nestedChild.localTransform, nestedChild.worldTransform);
  const nestedWorld = multiplyS8MaxMatrices(nestedChild.localTransform, nestedParent.worldTransform);
  for (let row = 0; row < 3; row += 1) for (const axis of ["x", "y", "z"] as const) assert.ok(Math.abs(nestedChild.worldTransform.rows[row]![axis] - nestedWorld.rows[row]![axis]) <= 1e-6);
  for (const axis of ["x", "y", "z"] as const) assert.ok(Math.abs(nestedChild.worldTransform.translation[axis] - nestedWorld.translation[axis]) <= 1e-6);
});

test("semantic manifest and independent readback compare separately and bind all tool versions", () => {
  const handoff = fixtureHandoff();
  const payload = buildS8Payload(stampFor(handoff), handoff);
  const binding = {
    sourceStampDigest: sourceStampDigest(payload.payload.sourceStamp), payloadSha256: payload.sha256,
    generationAppBundleId: "generation", generationAppBundleVersion: "1", generationAppBundleHash: HASH,
    generationActivityId: "generation", generationActivityVersion: "1", generationActivityHash: HASH,
    validatorAppBundleId: "validation", validatorAppBundleVersion: "1", validatorAppBundleHash: HASH,
    validatorActivityId: "validation", validatorActivityVersion: "1", validatorActivityHash: HASH,
    engineId: "engine", productVersion: "product", engineVersion: "engine-version", constructionAlgorithmVersion: "s8-max-scene-construction-v1" as const, semanticAlgorithmVersion: "s8-max-semantic-v1" as const,
  };
  const manifest = buildS8SemanticManifest({ projectId: PROJECT_ID, artifactId: "50000000-0000-4000-8000-000000000001" as UUID, sourceStamp: payload.payload.sourceStamp, payloadSha256: payload.sha256, binding }, payload.payload);
  const scene = buildS8Scene(payload.payload, manifest.artifactId, payload.sha256);
  const readback = buildS8IndependentReadback({ projectId: PROJECT_ID, artifactId: manifest.artifactId, sourceStampDigest: manifest.sourceStampDigest, payloadSha256: payload.sha256, binding, artifactSha256: HASH, artifactByteSize: 99, scene, checkedAt: "2026-09-03T00:00:00.001Z" });
  assert.equal(manifest.externalAssetCount, 0);
  assert.equal(manifest.externalDependencyCount, 0);
  assert.equal(compareS8SemanticManifest(manifest, readback).outcome, "pass");
  assert.equal(compareS8SemanticManifest(manifest, { ...readback, payloadSha256: SECOND_HASH }).outcome, "fail");
});

test("S8 service commits through mock OSS v2, keeps private fields private, and replays idempotently", async () => {
  const value = makeContext();
  const first = await value.service.createExport(PROJECT_ID, "s8-lifecycle-key");
  assert.equal(first.replayed, false);
  assert.equal(first.export.status, "committed");
  assert.equal("privateFinalStorageKey" in first.export, false);
  const state = value.repository.state();
  const collections = getS8Collections(state);
  assert.equal(collections.exports.length, 1);
  assert.equal(collections.manifests.length, 1);
  assert.equal(collections.generationReceipts.length, 1);
  assert.equal(collections.validationReceipts.length, 1);
  assert.equal(collections.validationReceipts[0]!.outcome, "pass");
  validateS8Graph(state);
  const download = value.service.download(PROJECT_ID, first.export.artifactId);
  assert.equal(download.fileName, "swooshz-s8-model.max");
  assert.ok(download.bytes.length > 0);
  const replay = await value.service.createExport(PROJECT_ID, "s8-lifecycle-key");
  assert.equal(replay.replayed, true);
  assert.equal(replay.export.artifactId, first.export.artifactId);
  assert.equal(value.service.getHandoff(PROJECT_ID).transportFileName, "swooshz-s8-payload.json");
});

test("provider holds retry without consuming candidate budget, while candidate failure gets one repair attempt", async () => {
  const providerHold = makeContext({ provider: createMockS8MaxProvider({ generationFailures: ["APS_RATE_LIMIT"] }) });
  const held = await providerHold.service.createExport(PROJECT_ID, "provider-hold-key");
  assert.equal(held.export.status, "provider_hold");
  assert.equal(held.export.candidateAttempt, 1);
  const resumed = await providerHold.service.retryExport(PROJECT_ID, held.export.artifactId, "provider-hold-retry");
  assert.equal(resumed.export.status, "committed");
  assert.equal(resumed.export.candidateAttempt, 1);
  assert.equal(getS8Collections(providerHold.repository.state()).jobs[0]!.generationProviderAttempts, 2);

  const exhaustedProvider = makeContext({ provider: createMockS8MaxProvider({ generationFailures: ["APS_RATE_LIMIT", "APS_RATE_LIMIT", "APS_RATE_LIMIT", "APS_RATE_LIMIT"] }) });
  const exhausted = await exhaustedProvider.service.createExport(PROJECT_ID, "provider-exhausted-key");
  assert.equal(exhausted.export.status, "provider_hold");
  await exhaustedProvider.service.retryExport(PROJECT_ID, exhausted.export.artifactId, "provider-exhausted-retry-1");
  await exhaustedProvider.service.retryExport(PROJECT_ID, exhausted.export.artifactId, "provider-exhausted-retry-2");
  const exhaustedState = getS8Collections(exhaustedProvider.repository.state());
  assert.equal(exhaustedState.jobs[0]!.generationProviderAttempts, 3);
  await exhaustedProvider.service.retryExport(PROJECT_ID, exhausted.export.artifactId, "provider-exhausted-retry-3");
  assert.equal(getS8Collections(exhaustedProvider.repository.state()).jobs[0]!.generationProviderAttempts, 3);

  const candidate = makeContext({ provider: createMockS8MaxProvider({ generationFailures: ["S8_UNSUPPORTED_GEOMETRY"] }) });
  const failed = await candidate.service.createExport(PROJECT_ID, "candidate-failure-key");
  assert.equal(failed.export.status, "failed_retryable");
  const repaired = await candidate.service.retryExport(PROJECT_ID, failed.export.artifactId, "candidate-repair-key");
  assert.equal(repaired.export.status, "committed");
  assert.equal(repaired.export.candidateAttempt, 2);
  assert.equal(getS8Collections(candidate.repository.state()).exports.length, 2);
  await assert.rejects(() => candidate.service.retryExport(PROJECT_ID, repaired.export.artifactId, "candidate-third-key"), /S8_RETRY_NOT_AVAILABLE/u);
});

test("G3 repair regression: provider dispositions distinguish candidate and terminal compatibility failures", async () => {
  const instructions = makeContext({ provider: createMockS8MaxProvider({ generationFailures: ["APS_INSTRUCTIONS_FAILED"] }) });
  const instructionFailure = await instructions.service.createExport(PROJECT_ID, "instructions-failure-key");
  assert.equal(instructionFailure.export.status, "failed_retryable");

  for (const [code, key] of [["APS_AUTH_FAILURE", "auth-failure-key"], ["APS_ENGINE_DEPRECATED", "deprecated-key"], ["APS_ENGINE_VERSION_MOVED", "moved-key"]] as const) {
    const terminal = makeContext({ provider: createMockS8MaxProvider({ generationFailures: [code] }) });
    const held = await terminal.service.createExport(PROJECT_ID, key);
    assert.equal(held.export.status, "provider_hold");
    await assert.rejects(() => terminal.service.retryExport(PROJECT_ID, held.export.artifactId, `${key}-retry`), /S8_RETRY_NOT_AVAILABLE/u);
  }
});

test("G3 provider taxonomy is explicit for transfer, semantic, retry-after, and stale outcomes", () => {
  for (const code of ["S8_NATIVE_SAVE_FAILED", "S8_UNSUPPORTED_GEOMETRY", "S8_PROFILE_TRIANGULATION_FAILED", "S7_CROSS_OUTPUT_MISMATCH", "APS_INSTRUCTIONS_FAILED"] as const) {
    const disposition = classifyS8ProviderFailure(code);
    assert.equal(disposition.classification, "candidate_failure");
    assert.equal(disposition.consumesCandidateAttempt, true);
    assert.equal(disposition.controllerRequired, false);
  }
  for (const code of ["APS_UNAVAILABLE", "APS_QUEUE_DELAY", "APS_RATE_LIMIT", "APS_ENGINE_UNAVAILABLE", "APS_INPUT_DOWNLOAD_FAILED", "APS_WORKITEM_FAILED", "APS_TIMEOUT", "APS_OUTPUT_UPLOAD_FAILED", "APS_OUTPUT_INTEGRITY_MISMATCH", "APS_VALIDATOR_FAILED"] as const) {
    const disposition = classifyS8ProviderFailure(code);
    assert.equal(disposition.classification, "provider_hold");
    assert.equal(disposition.consumesCandidateAttempt, false);
  }
  for (const code of ["APS_AUTH_FAILURE", "APS_ENGINE_DEPRECATED", "APS_ENGINE_VERSION_MOVED", "APS_OUTPUT_MISSING"] as const) {
    const disposition = classifyS8ProviderFailure(code);
    assert.equal(disposition.classification, "provider_hold");
    assert.equal(disposition.retryable, false);
    assert.equal(disposition.controllerRequired, true);
    assert.equal(disposition.reconciliationRequired, true);
  }
  assert.equal(classifyS8ProviderFailure("APS_ENGINE_UNAVAILABLE", "compatibility").controllerRequired, true);
  assert.equal(classifyS8ProviderFailure("APS_VALIDATOR_FAILED", "semantic").classification, "candidate_failure");
  assert.equal(classifyS8ProviderFailure("APS_INPUT_DOWNLOAD_FAILED", "transfer_defect").controllerRequired, true);
  assert.equal(classifyS8ProviderFailure("SOURCE_STALE").classification, "stale");
  const rateLimited = new S8MaxProviderError("APS_RATE_LIMIT", "generation", true, "rate limited", "rate_limit", 37);
  assert.equal(rateLimited.retryAfterSeconds, 37);
  assert.equal(classifyS8ProviderFailure(rateLimited.code, rateLimited.cause).honorRetryAfter, true);
});

test("G3 repair regression: every provider failure class has an explicit terminal disposition", () => {
  const cases = [
    ["APS_UNAVAILABLE", undefined, { classification: "provider_hold", retryable: true, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["APS_QUEUE_DELAY", undefined, { classification: "provider_hold", retryable: true, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["APS_RATE_LIMIT", undefined, { classification: "provider_hold", retryable: true, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: true, terminal: false }],
    ["APS_AUTH_FAILURE", undefined, { classification: "provider_hold", retryable: false, consumesCandidateAttempt: false, controllerRequired: true, reconciliationRequired: true, honorRetryAfter: false, terminal: true }],
    ["APS_ENGINE_UNAVAILABLE", "provider_transient", { classification: "provider_hold", retryable: true, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["APS_ENGINE_UNAVAILABLE", "compatibility", { classification: "provider_hold", retryable: false, consumesCandidateAttempt: false, controllerRequired: true, reconciliationRequired: true, honorRetryAfter: false, terminal: true }],
    ["APS_ENGINE_DEPRECATED", undefined, { classification: "provider_hold", retryable: false, consumesCandidateAttempt: false, controllerRequired: true, reconciliationRequired: true, honorRetryAfter: false, terminal: true }],
    ["APS_ENGINE_VERSION_MOVED", undefined, { classification: "provider_hold", retryable: false, consumesCandidateAttempt: false, controllerRequired: true, reconciliationRequired: true, honorRetryAfter: false, terminal: true }],
    ["APS_INPUT_DOWNLOAD_FAILED", "transfer_transient", { classification: "provider_hold", retryable: true, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["APS_INPUT_DOWNLOAD_FAILED", "rate_limit", { classification: "provider_hold", retryable: true, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: true, terminal: false }],
    ["APS_INPUT_DOWNLOAD_FAILED", "transfer_defect", { classification: "provider_hold", retryable: false, consumesCandidateAttempt: false, controllerRequired: true, reconciliationRequired: true, honorRetryAfter: false, terminal: true }],
    ["APS_WORKITEM_FAILED", "provider_transient", { classification: "provider_hold", retryable: true, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["APS_WORKITEM_FAILED", "rate_limit", { classification: "provider_hold", retryable: true, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: true, terminal: false }],
    ["APS_WORKITEM_FAILED", "script", { classification: "candidate_failure", retryable: true, consumesCandidateAttempt: true, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["APS_WORKITEM_FAILED", "business", { classification: "candidate_failure", retryable: true, consumesCandidateAttempt: true, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["APS_TIMEOUT", "queue", { classification: "provider_hold", retryable: true, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["APS_TIMEOUT", "rate_limit", { classification: "provider_hold", retryable: true, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: true, terminal: false }],
    ["APS_TIMEOUT", "script", { classification: "candidate_failure", retryable: true, consumesCandidateAttempt: true, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["APS_OUTPUT_UPLOAD_FAILED", "transfer_transient", { classification: "provider_hold", retryable: true, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["APS_OUTPUT_UPLOAD_FAILED", "rate_limit", { classification: "provider_hold", retryable: true, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: true, terminal: false }],
    ["APS_OUTPUT_UPLOAD_FAILED", "transfer_defect", { classification: "provider_hold", retryable: false, consumesCandidateAttempt: false, controllerRequired: true, reconciliationRequired: true, honorRetryAfter: false, terminal: true }],
    ["APS_OUTPUT_MISSING", undefined, { classification: "provider_hold", retryable: false, consumesCandidateAttempt: false, controllerRequired: true, reconciliationRequired: true, honorRetryAfter: false, terminal: true }],
    ["APS_OUTPUT_INTEGRITY_MISMATCH", "transfer_transient", { classification: "provider_hold", retryable: true, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["APS_OUTPUT_INTEGRITY_MISMATCH", "rate_limit", { classification: "provider_hold", retryable: true, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: true, terminal: false }],
    ["APS_OUTPUT_INTEGRITY_MISMATCH", "semantic", { classification: "candidate_failure", retryable: true, consumesCandidateAttempt: true, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["APS_VALIDATOR_FAILED", "provider_transient", { classification: "provider_hold", retryable: true, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["APS_VALIDATOR_FAILED", "rate_limit", { classification: "provider_hold", retryable: true, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: true, terminal: false }],
    ["APS_VALIDATOR_FAILED", "semantic", { classification: "candidate_failure", retryable: true, consumesCandidateAttempt: true, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["S8_NATIVE_SAVE_FAILED", undefined, { classification: "candidate_failure", retryable: true, consumesCandidateAttempt: true, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["S8_UNSUPPORTED_GEOMETRY", undefined, { classification: "candidate_failure", retryable: true, consumesCandidateAttempt: true, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["S8_PROFILE_TRIANGULATION_FAILED", undefined, { classification: "candidate_failure", retryable: true, consumesCandidateAttempt: true, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["S7_CROSS_OUTPUT_MISMATCH", undefined, { classification: "candidate_failure", retryable: true, consumesCandidateAttempt: true, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["APS_INSTRUCTIONS_FAILED", undefined, { classification: "candidate_failure", retryable: true, consumesCandidateAttempt: true, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: false }],
    ["SOURCE_STALE", undefined, { classification: "stale", retryable: false, consumesCandidateAttempt: false, controllerRequired: false, reconciliationRequired: false, honorRetryAfter: false, terminal: true }],
  ] as const;
  for (const [code, cause, expected] of cases) {
    const actual = cause === undefined ? classifyS8ProviderFailure(code) : classifyS8ProviderFailure(code, cause);
    assert.deepEqual(actual, expected, `${code}/${cause ?? "default"}`);
  }
});

test("validation provider hold resumes from promoted staging without a second candidate", async () => {
  const value = makeContext({ provider: createMockS8MaxProvider({ validationFailures: ["APS_TIMEOUT"] }) });
  const held = await value.service.createExport(PROJECT_ID, "validation-hold-key");
  assert.equal(held.export.status, "provider_hold");
  assert.equal(held.export.publicationPhase, "promoted");
  const resumed = await value.service.retryExport(PROJECT_ID, held.export.artifactId, "validation-hold-retry");
  assert.equal(resumed.export.status, "committed");
  assert.equal(resumed.export.candidateAttempt, 1);
  validateS8Graph(value.repository.state());
});

test("G3 repair regression: Retry-After is durable and gates provider retry without consuming candidate budget", async () => {
  let now: Timestamp = "2026-09-05T00:00:00.000Z";
  const value = makeContext({
    clock: () => now,
    provider: createMockS8MaxProvider({ generationFailures: [{ code: "APS_RATE_LIMIT", retryAfterSeconds: 37 }] }),
  });
  const held = await value.service.createExport(PROJECT_ID, "retry-after-key");
  const initial = getS8Collections(value.repository.state());
  assert.equal(held.export.status, "provider_hold");
  assert.equal(held.export.providerRetryAfterAt, "2026-09-05T00:00:37.000Z");
  assert.equal(initial.jobs[0]!.providerRetryAfterAt, "2026-09-05T00:00:37.000Z");
  assert.equal(initial.jobs[0]!.generationProviderAttempts, 1);
  assert.equal(held.export.candidateAttempt, 1);

  const early = await value.service.retryExport(PROJECT_ID, held.export.artifactId, "retry-after-early");
  assert.equal(early.export.status, "provider_hold");
  assert.equal(getS8Collections(value.repository.state()).jobs[0]!.generationProviderAttempts, 1);

  now = "2026-09-05T00:00:37.000Z";
  const resumed = await value.service.retryExport(PROJECT_ID, held.export.artifactId, "retry-after-due");
  assert.equal(resumed.export.status, "committed");
  assert.equal(resumed.export.candidateAttempt, 1);
  assert.equal(getS8Collections(value.repository.state()).jobs[0]!.providerRetryAfterAt, null);
  validateS8Graph(value.repository.state());
});

test("source movement supersedes committed S8 history before a new export is admitted", async () => {
  const value = makeContext();
  const first = await value.service.createExport(PROJECT_ID, "s8-source-first");
  assert.equal(first.export.status, "committed");

  value.move(fixtureHandoff({ revisionId: "30000000-0000-4000-8000-000000000099" as UUID, revisionHash: SECOND_HASH }));
  const s7Moved = value.s7.createExport(PROJECT_ID, "s7-source-moved");
  assert.equal(s7Moved.export.status, "committed");

  const second = await value.service.createExport(PROJECT_ID, "s8-source-second");
  assert.equal(second.export.status, "committed");
  const exports = getS8Collections(value.repository.state()).exports;
  const superseded = exports.find((item) => item.artifactId === first.export.artifactId);
  const current = exports.find((item) => item.artifactId === second.export.artifactId);
  assert.equal(superseded?.status, "superseded");
  assert.equal(superseded?.supersededAt !== null, true);
  assert.equal(current?.sourceStamp.s6RevisionHash, SECOND_HASH);
});

test("source movement is fenced at every S8 publication boundary, including retry and download", async () => {
  const initialPhases: S8PublicationPhase[] = ["admission", "payload", "provider-submit", "provider-result", "staging", "promotion", "validation", "commit"];
  for (const [index, expectedPhase] of initialPhases.entries()) {
    let value!: ReturnType<typeof makeContext>;
    let moved = false;
    const next = fixtureHandoff({ revisionId: `30000000-0000-4000-8000-0000000000${String(index + 10).padStart(2, "0")}` as UUID, revisionHash: `${String(index + 1).padStart(2, "0")}${"c".repeat(62)}` });
    value = makeContext({ onPublicationPhase: (phase) => {
      if (phase !== expectedPhase || moved) return;
      moved = true;
      value.move(next);
      assert.equal(value.s7.createExport(PROJECT_ID, `s7-fence-${String(index)}`).export.status, "committed");
    } });
    await assert.rejects(() => value.service.createExport(PROJECT_ID, `s8-fence-${String(index)}`), /SOURCE_STALE/u);
    assert.equal(moved, true);
  }

  let retryValue!: ReturnType<typeof makeContext>;
  let retryMoved = false;
  retryValue = makeContext({ provider: createMockS8MaxProvider({ generationFailures: ["S8_UNSUPPORTED_GEOMETRY"] }), onPublicationPhase: (phase) => {
    if (phase !== "retry" || retryMoved) return;
    retryMoved = true;
    retryValue.move(fixtureHandoff({ revisionId: "30000000-0000-4000-8000-000000000099" as UUID, revisionHash: SECOND_HASH }));
    assert.equal(retryValue.s7.createExport(PROJECT_ID, "s7-fence-retry").export.status, "committed");
  } });
  const failed = await retryValue.service.createExport(PROJECT_ID, "s8-fence-retry");
  assert.equal(failed.export.status, "failed_retryable");
  await assert.rejects(() => retryValue.service.retryExport(PROJECT_ID, failed.export.artifactId, "s8-fence-retry-2"), /SOURCE_STALE/u);
  assert.equal(retryMoved, true);
  assert.equal(getS8Collections(retryValue.repository.state()).exports.length, 1);
  assert.equal(getS8Collections(retryValue.repository.state()).exports[0]!.status, "stale");

  let downloadValue!: ReturnType<typeof makeContext>;
  let downloadMoved = false;
  downloadValue = makeContext({ onPublicationPhase: (phase) => {
    if (phase !== "download" || downloadMoved) return;
    downloadMoved = true;
    downloadValue.move(fixtureHandoff({ revisionId: "30000000-0000-4000-8000-000000000098" as UUID, revisionHash: SECOND_HASH }));
    assert.equal(downloadValue.s7.createExport(PROJECT_ID, "s7-fence-download").export.status, "committed");
  } });
  const committed = await downloadValue.service.createExport(PROJECT_ID, "s8-fence-download");
  assert.equal(committed.export.status, "committed");
  assert.throws(() => downloadValue.service.download(PROJECT_ID, committed.export.artifactId), /SOURCE_STALE/u);
  assert.equal(downloadMoved, true);
  assert.equal(getS8Collections(downloadValue.repository.state()).exports[0]!.status, "superseded");
});

test("S8 claim CAS and recovery distinguish the live or uncertain owner from a proven-dead owner", async () => {
  const underlying = createMockS8MaxProvider();
  let startedResolve: (() => void) | null = null;
  let releaseResolve: (() => void) | null = null;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  const released = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const provider: S8MaxProvider = {
    providerKind: "mock-oss-v2",
    async generate(input) {
      startedResolve?.();
      await released;
      return underlying.generate(input);
    },
    validate: (input) => underlying.validate(input),
  };
  const value = makeContext({ provider });
  const firstPromise = value.service.createExport(PROJECT_ID, "s8-claim-race");
  await started;
  const job = getS8Collections(value.repository.state()).jobs[0]!;
  const loser = await value.service.process(job.jobId);
  assert.equal(loser.status, "provider_pending");

  const uncertain = new S8MaxService({ repository: value.repository, objects: value.objects, s6: value.s6, s7: value.s7, provider: underlying, ownerProcessId: "uncertain-owner", isOwnerProcessAlive: () => { throw new Error("liveness unavailable"); } });
  assert.equal(uncertain.recoverPending(), 0);
  assert.equal(getS8Collections(value.repository.state()).jobs[0]!.status, "provider_pending");

  const dead = new S8MaxService({ repository: value.repository, objects: value.objects, s6: value.s6, s7: value.s7, provider: underlying, ownerProcessId: "recovery-owner", isOwnerProcessAlive: () => false });
  value.repository.transact((state) => {
    const current = getS8Collections(state).jobs[0]!;
    current.heartbeatAt = "2020-01-01T00:00:00.000Z";
  });
  assert.equal(dead.recoverPending(), 1);
  assert.equal(getS8Collections(value.repository.state()).jobs[0]!.status, "provider_hold");

  releaseResolve!();
  await assert.rejects(() => firstPromise, /S8_CLAIM_FENCED/u);
  assert.equal(getS8Collections(value.repository.state()).jobs[0]!.status, "provider_hold");
});

test("S7 cross-output evidence is required and mismatched identity is rejected", () => {
  const value = makeContext();
  const original = value.s7.getHandoff(PROJECT_ID);
  const fakeS7 = {
    repository: value.repository,
    getHandoff: () => ({ ...original, s7ArtifactHash: SECOND_HASH }),
  } as never;
  const mismatched = new S8MaxService({ repository: value.repository, objects: value.objects, s6: value.s6, s7: fakeS7, provider: createMockS8MaxProvider(), ownerProcessId: "s8-mismatch-owner" });
  assert.throws(() => mismatched.getHandoff(PROJECT_ID), /S7_CROSS_OUTPUT_MISMATCH/u);
});

test("G3 repair regression: dead-owner recovery waits for an expired heartbeat", async () => {
  const underlying = createMockS8MaxProvider();
  let startedResolve: (() => void) | null = null;
  let releaseResolve: (() => void) | null = null;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  const released = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const provider: S8MaxProvider = {
    providerKind: "mock-oss-v2",
    async generate(input) {
      startedResolve?.();
      await released;
      return underlying.generate(input);
    },
    validate: (input) => underlying.validate(input),
  };
  const value = makeContext({ provider });
  const firstPromise = value.service.createExport(PROJECT_ID, "heartbeat-regression-key");
  await started;
  const pending = getS8Collections(value.repository.state()).jobs[0]!;
  const freshDead = new S8MaxService({ repository: value.repository, objects: value.objects, s6: value.s6, s7: value.s7, provider: underlying, ownerProcessId: "fresh-dead-owner", clock: () => pending.heartbeatAt!, isOwnerProcessAlive: () => false });
  assert.equal(freshDead.recoverPending(), 0);
  assert.equal(getS8Collections(value.repository.state()).jobs[0]!.status, "provider_pending");

  value.repository.transact((state) => {
    const job = getS8Collections(state).jobs[0]!;
    job.heartbeatAt = "2020-01-01T00:00:00.000Z";
  });
  const expiredDead = new S8MaxService({ repository: value.repository, objects: value.objects, s6: value.s6, s7: value.s7, provider: underlying, ownerProcessId: "expired-dead-owner", clock: () => "2026-09-05T00:00:00.000Z", isOwnerProcessAlive: () => false });
  assert.equal(expiredDead.recoverPending(), 1);
  assert.equal(getS8Collections(value.repository.state()).jobs[0]!.status, "provider_hold");
  releaseResolve!();
  await assert.rejects(() => firstPromise, /S8_CLAIM_FENCED/u);
});

test("G3 recovery requeues only pre-provider work and fences source movement", async () => {
  const value = makeContext({ provider: createMockS8MaxProvider({ generationFailures: ["S8_UNSUPPORTED_GEOMETRY"] }) });
  const failed = await value.service.createExport(PROJECT_ID, "recovery-local-key");
  const jobId = failed.job.jobId;
  const claimToken = "60000000-0000-4000-8000-000000000001" as UUID;
  value.repository.transact((state) => {
    const current = getS8Collections(state);
    const job = current.jobs.find((item) => item.jobId === jobId)!;
    const artifact = current.exports.find((item) => item.artifactId === job.artifactId)!;
    job.status = "running"; job.stage = "generation"; job.claimToken = claimToken; job.ownerProcessId = "dead-local-owner"; job.claimedAt = "2020-01-01T00:00:00.000Z"; job.heartbeatAt = "2020-01-01T00:00:00.000Z"; job.terminalAt = null; job.controllerRequired = false;
    artifact.status = "running"; artifact.publicationPhase = "none"; artifact.committedAt = null; artifact.failureCode = null; artifact.controllerRequired = false;
  });
  const recovered = new S8MaxService({ repository: value.repository, objects: value.objects, s6: value.s6, s7: value.s7, provider: createMockS8MaxProvider(), ownerProcessId: "recovery-local-owner", clock: () => "2026-09-05T00:00:00.000Z", isOwnerProcessAlive: () => false });
  assert.equal(recovered.recoverPending(), 1);
  const requeued = getS8Collections(value.repository.state()).jobs.find((item) => item.jobId === jobId)!;
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.controllerRequired, false);
  assert.equal(requeued.claimToken, null);

  const moved = makeContext();
  const movedExport = await moved.service.createExport(PROJECT_ID, "recovery-source-key");
  moved.repository.transact((state) => {
    const current = getS8Collections(state);
    const job = current.jobs.find((item) => item.jobId === movedExport.job.jobId)!;
    const artifact = current.exports.find((item) => item.artifactId === job.artifactId)!;
    job.status = "provider_running"; job.stage = "generation"; job.claimToken = claimToken; job.ownerProcessId = "moved-owner"; job.claimedAt = "2020-01-01T00:00:00.000Z"; job.heartbeatAt = "2020-01-01T00:00:00.000Z"; job.terminalAt = null; job.controllerRequired = false;
    artifact.status = "provider_running"; artifact.publicationPhase = "none"; artifact.committedAt = null; artifact.failureCode = null; artifact.controllerRequired = false;
  });
  let movedOnce = false;
  const next = fixtureHandoff({ revisionId: "30000000-0000-4000-8000-000000000099" as UUID, revisionHash: SECOND_HASH });
  const movingRecovery = new S8MaxService({ repository: moved.repository, objects: moved.objects, s6: moved.s6, s7: moved.s7, provider: createMockS8MaxProvider(), ownerProcessId: "moving-recovery-owner", clock: () => "2026-09-05T00:00:00.000Z", isOwnerProcessAlive: () => { if (!movedOnce) { movedOnce = true; moved.move(next); moved.s7.createExport(PROJECT_ID, "s7-recovery-source-moved"); } return false; } });
  assert.equal(movingRecovery.recoverPending(), 0);
  assert.equal(getS8Collections(moved.repository.state()).exports.find((item) => item.artifactId === movedExport.export.artifactId)?.status, "stale");
});

test("G3 repair regression: expired recovery requires proven death and fences every uncertain phase", async () => {
  const seed = async (status: "running" | "provider_running" | "staged" | "validating", publicationPhase: "none" | "staged" | "promoted") => {
    const value = makeContext({ provider: createMockS8MaxProvider({ generationFailures: ["S8_UNSUPPORTED_GEOMETRY"] }) });
    const failed = await value.service.createExport(PROJECT_ID, `recovery-matrix-${status}`);
    const token = (`60000000-0000-4000-8000-${String(status.length).padStart(12, "0")}`) as UUID;
    value.repository.transact((state) => {
      const current = getS8Collections(state);
      const job = current.jobs.find((item) => item.jobId === failed.job.jobId)!;
      const artifact = current.exports.find((item) => item.artifactId === job.artifactId)!;
      job.status = status; job.stage = status === "validating" ? "validation" : "generation"; job.claimToken = token; job.ownerProcessId = "expired-owner"; job.claimedAt = "2020-01-01T00:00:00.000Z"; job.heartbeatAt = "2020-01-01T00:00:00.000Z"; job.providerRetryAfterAt = null; job.terminalAt = null; job.controllerRequired = false;
      artifact.status = status; artifact.publicationPhase = publicationPhase; artifact.committedAt = null; artifact.staleAt = null; artifact.supersededAt = null; artifact.failureCode = null; artifact.providerRetryAfterAt = null; artifact.controllerRequired = false;
    });
    return { value, jobId: failed.job.jobId, artifactId: failed.export.artifactId, token };
  };
  const future = () => "2026-09-05T00:00:00.000Z" as Timestamp;

  const live = await seed("provider_running", "none");
  const liveRecovery = new S8MaxService({ repository: live.value.repository, objects: live.value.objects, s6: live.value.s6, s7: live.value.s7, provider: createMockS8MaxProvider(), ownerProcessId: "live-recovery", clock: future, isOwnerProcessAlive: () => true });
  assert.equal(liveRecovery.recoverPending(), 0);
  assert.equal(getS8Collections(live.value.repository.state()).jobs[0]!.status, "provider_running");

  const unknown = await seed("provider_running", "none");
  const unknownRecovery = new S8MaxService({ repository: unknown.value.repository, objects: unknown.value.objects, s6: unknown.value.s6, s7: unknown.value.s7, provider: createMockS8MaxProvider(), ownerProcessId: "unknown-recovery", clock: future });
  assert.equal(unknownRecovery.recoverPending(), 0);
  assert.equal(getS8Collections(unknown.value.repository.state()).jobs[0]!.status, "provider_running");

  const dead = await seed("provider_running", "none");
  const deadRecovery = new S8MaxService({ repository: dead.value.repository, objects: dead.value.objects, s6: dead.value.s6, s7: dead.value.s7, provider: createMockS8MaxProvider(), ownerProcessId: "dead-recovery", clock: future, isOwnerProcessAlive: () => false });
  assert.equal(deadRecovery.recoverPending(), 1);
  assert.equal(getS8Collections(dead.value.repository.state()).jobs[0]!.status, "provider_hold");
  assert.equal(getS8Collections(dead.value.repository.state()).exports[0]!.failureCode, "APS_WORKITEM_FAILED");
  assert.equal(getS8Collections(dead.value.repository.state()).jobs[0]!.claimToken, null);

  for (const [status, phase] of [["staged", "staged"], ["validating", "promoted"]] as const) {
    const uncertain = await seed(status, phase);
    const recovery = new S8MaxService({ repository: uncertain.value.repository, objects: uncertain.value.objects, s6: uncertain.value.s6, s7: uncertain.value.s7, provider: createMockS8MaxProvider(), ownerProcessId: `${status}-recovery`, clock: future, isOwnerProcessAlive: () => false });
    assert.equal(recovery.recoverPending(), 1);
    assert.equal(getS8Collections(uncertain.value.repository.state()).jobs[0]!.status, "provider_hold");
    assert.equal(getS8Collections(uncertain.value.repository.state()).exports[0]!.providerRetryAfterAt, null);
  }

  const local = await seed("running", "none");
  const localRecovery = new S8MaxService({ repository: local.value.repository, objects: local.value.objects, s6: local.value.s6, s7: local.value.s7, provider: createMockS8MaxProvider(), ownerProcessId: "local-recovery", clock: future, isOwnerProcessAlive: () => false });
  assert.equal(localRecovery.recoverPending(), 1);
  assert.equal(getS8Collections(local.value.repository.state()).jobs[0]!.status, "queued");

  const raced = await seed("provider_running", "none");
  let racedOnce = false;
  const replacementToken = "60000000-0000-4000-8000-000000000099" as UUID;
  const raceRecovery = new S8MaxService({ repository: raced.value.repository, objects: raced.value.objects, s6: raced.value.s6, s7: raced.value.s7, provider: createMockS8MaxProvider(), ownerProcessId: "race-recovery", clock: future, isOwnerProcessAlive: () => {
    if (!racedOnce) {
      racedOnce = true;
      raced.value.repository.transact((state) => {
        const job = getS8Collections(state).jobs.find((item) => item.jobId === raced.jobId)!;
        job.claimToken = replacementToken; job.ownerProcessId = "replacement-owner";
      });
    }
    return false;
  } });
  assert.equal(raceRecovery.recoverPending(), 0);
  const racedJob = getS8Collections(raced.value.repository.state()).jobs[0]!;
  assert.equal(racedJob.status, "provider_running");
  assert.equal(racedJob.claimToken, replacementToken);
});

test("mock OSS v2 transfer is private, write-once, and integrity-preserving", () => {
  const transfer = new MockOssV2Transfer();
  const staged = transfer.putExact("projects/p/s8/staging/job/claim/swooshz-s8-model.max", Buffer.from("native-mock"));
  assert.equal(staged.sha256, sha256(Buffer.from("native-mock")));
  assert.deepEqual(transfer.readExact("projects/p/s8/staging/job/claim/swooshz-s8-model.max").bytes, Buffer.from("native-mock"));
  const promoted = transfer.promoteExact("projects/p/s8/staging/job/claim/swooshz-s8-model.max", "projects/p/s8/exports/artifact/swooshz-s8-model.max");
  assert.equal(promoted.byteSize, 11);
  assert.throws(() => transfer.putExact("projects/p/s8/staging/job/claim/swooshz-s8-model.max", Buffer.from("changed")), /S8_OUTPUT_EXISTS/u);
  assert.throws(() => transfer.promoteExact("projects/p/s8/staging/job/claim/swooshz-s8-model.max", "projects/p/s8/exports/artifact/swooshz-s8-model.max"), /S8_OUTPUT_EXISTS/u);
});

test("unsupported geometry fails closed before any native artifact is accepted", () => {
  const handoff = fixtureHandoff({ objects: [objectValue({ objectType: "table", geometry: { kind: "profile_extrusion", profile: { winding: "ccw-from-positive-y-v1", vertices: [{ xMm: 0, zMm: 0 }, { xMm: 0, zMm: 100 }, { xMm: 100, zMm: 100 }, { xMm: 100, zMm: 0 }] }, heightMm: 100, geometryState: "exact", localAnchor: "floor" }, boundsMm: { widthMm: 100, depthMm: 100, heightMm: 100 } })] });
  const payload = buildS8Payload(stampFor(handoff), handoff);
  assert.throws(() => buildS8Scene(payload.payload, "50000000-0000-4000-8000-000000000001" as UUID, payload.sha256), /S8_UNSUPPORTED_GEOMETRY/u);
});

test("empty persisted S8 collections remain additive to pre-S8 store state", () => {
  const state = emptyStoreState();
  assert.deepEqual(state.s8MaxExports, []);
  assert.deepEqual(state.s8MaxJobs, []);
  assert.deepEqual(state.s8MaxIdempotency, []);
  assert.deepEqual(state.s8MaxManifests, []);
  assert.deepEqual(state.s8MaxGenerationReceipts, []);
  assert.deepEqual(state.s8MaxValidationReceipts, []);
  assert.deepEqual(state.s8MaxProviderMetadata, []);
});

test("S8 API authorizes before service construction and resource limits fail closed", async () => {
  let touched = false;
  const denied: ApiRequestDependencies = {
    get workflowService() { touched = true; throw new Error("service must not be constructed"); },
    s3Authorization: { resolveContext: async () => null, authorizeProject: async () => false },
  } as unknown as ApiRequestDependencies;
  const artifactId = "40000000-0000-4000-8000-000000000099";
  const response = await handleApiRequest(new Request("http://local/api", { method: "GET" }), ["projects", PROJECT_ID, "s8", "exports", artifactId], denied);
  assert.equal(response.status, 404);
  assert.equal(touched, false);
  assert.equal(JSON.stringify(await response.json()).includes(artifactId), false);

  const tooManyObjects = Array.from({ length: 257 }, (_value, index) => objectValue({ objectId: `object-${String(index)}`, identityKey: `identity-${String(index)}` }));
  const objectLimited = fixtureHandoff({ objects: tooManyObjects });
  assert.throws(() => buildS8Payload(stampFor(objectLimited), objectLimited), /S8_RESOURCE_LIMIT/u);

  const tooManyProfile = { kind: "profile_extrusion", profile: { winding: "ccw-from-positive-y-v1" as const, vertices: Array.from({ length: 25 }, (_value, index) => ({ xMm: index * 200, zMm: 0 })) }, heightMm: 100, geometryState: "exact" as const, localAnchor: "floor" as const };
  const profileLimited = fixtureHandoff({ objects: [objectValue({ geometry: tooManyProfile, boundsMm: { widthMm: 4800, depthMm: 1, heightMm: 100 } })] });
  assert.throws(() => buildS8Payload(stampFor(profileLimited), profileLimited), /S8_RESOURCE_LIMIT/u);
});
