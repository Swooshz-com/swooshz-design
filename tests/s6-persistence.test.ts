import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AppError,
  type S6AcceptanceEvent,
  type S6SpatialModelRecord,
  type S6SupersessionEvent,
  type S6ViewArtifact,
  type StoreState,
  type UUID,
} from "../src/lib/types";
import { emptyStoreState, JsonRepository } from "../src/lib/store";
import { hashS6Model } from "../src/lib/s6-canonical";

const HASH = "a".repeat(64);
const PROJECT_ID = "10000000-0000-4000-8000-000000000001" as UUID;
const APPROVAL_EVENT_ID = "10000000-0000-4000-8000-000000000002" as UUID;
const EVIDENCE_ASSET_ID = "10000000-0000-4000-8000-000000000003" as UUID;

function id(value: number): UUID {
  return `10000000-0000-4000-8000-${String(value).padStart(12, "0")}` as UUID;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeModel(options: {
  revision?: number;
  parentRevision?: number | null;
  status?: S6SpatialModelRecord["status"];
  identityKey?: string;
} = {}): S6SpatialModelRecord {
  const revision = options.revision ?? 1;
  const parentRevision = options.parentRevision === undefined ? null : options.parentRevision;
  const model: S6SpatialModelRecord = {
    schemaVersion: "s6-spatial-model-v1",
    modelRevisionId: id(10 + revision),
    projectId: PROJECT_ID,
    parentRevisionId: parentRevision === null ? null : id(10 + parentRevision),
    parentRevisionHash: parentRevision === null ? null : HASH,
    revisionNumber: revision,
    sourceS5Fingerprint: HASH,
    sourceS5ApprovalEventId: APPROVAL_EVENT_ID,
    sourceS5ApprovalGeneration: 1,
    status: options.status ?? "generated_draft",
    booth: {
      widthMm: 6000,
      depthMm: 3000,
      openSides: ["north", "east"],
      maxHeightMm: 3000,
      coordinateConvention: {
        version: "booth-local-right-handed-v1",
        units: "millimetres",
        handedness: "right-handed",
        origin: "north-west-floor-corner",
        xAxis: "east",
        yAxis: "up",
        zAxis: "south",
      },
      heightState: "known",
    },
    objects: [{
      objectId: "s6o_floor",
      identityKey: "booth-floor",
      parentObjectId: null,
      objectType: "floor_footprint",
      role: "booth_floor",
      label: "Floor",
      primitive: {
        kind: "rect_prism",
        dimensionsMm: { widthMm: 6000, depthMm: 3000, heightMm: 1 },
        geometryState: "exact",
        localAnchor: "floor",
      },
      transform: { positionMm: { xMm: 0, yMm: 0, zMm: 0 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } },
      zoneIds: [],
      requirementIds: [],
      materialIds: [],
      unknownIds: [],
      provenance: {
        kind: "confirmed_project_input",
        sourceRef: "s5.geometrySnapshot",
        sourceFingerprint: HASH,
        acceptedByUser: true,
        note: null,
      },
      hardConstraint: "booth_envelope",
      editable: false,
      removable: false,
    }],
    zones: [],
    materials: [],
    cameras: [],
    provenance: [],
    assumptions: [],
    unknowns: [],
    designFormReview: {
      status: "required",
      evidenceAssetId: EVIDENCE_ASSET_ID,
      evidenceAssetSha256: HASH,
      sourceS5Fingerprint: HASH,
      reviewedObjectIds: [],
      unresolvedUnknownIds: [],
      explicitSimplificationUnknownIds: [],
      acceptedByUser: false,
    },
    modelHash: HASH,
    canonicalByteSize: 0,
    modelArtifact: {
      artifactKey: `projects/${PROJECT_ID}/s6/revisions/${id(10 + revision)}/model.json`,
      stagingKey: `projects/${PROJECT_ID}/s6/staging/job/claim/model.json`,
      sha256: null,
      byteSize: null,
      status: "not_written",
    },
    validationReceiptId: null,
    acceptanceEventId: null,
    createdBy: "compiler",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    acceptedAt: null,
    supersededAt: null,
    staleAt: null,
  };
  if (options.identityKey) model.objects[0]!.identityKey = options.identityKey;
  const digest = hashS6Model(model);
  model.modelHash = digest.modelHash;
  model.canonicalByteSize = digest.canonicalByteSize;
  return model;
}

function linkChild(parent: S6SpatialModelRecord, child: S6SpatialModelRecord): S6SpatialModelRecord {
  child.parentRevisionHash = parent.modelHash;
  const digest = hashS6Model(child);
  child.modelHash = digest.modelHash;
  child.canonicalByteSize = digest.canonicalByteSize;
  return child;
}

function stateWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...emptyStoreState(),
    s6SpatialModels: [],
    s6ValidationReceipts: [],
    s6CorrectionEvents: [],
    s6AcceptanceEvents: [],
    s6SupersessionEvents: [],
    s6ViewArtifacts: [],
    s6ViewPreservationReceipts: [],
    s6Jobs: [],
    s6Idempotency: [],
    ...overrides,
  };
}

function withRepository(state: unknown, action: (repository: JsonRepository) => void): void {
  const root = mkdtempSync(join(tmpdir(), "s6-persistence-"));
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify(state), "utf8");
    action(new JsonRepository(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertPersistenceFailure(action: () => void): void {
  assert.throws(action, (error: unknown) => error instanceof AppError && error.code === "PERSISTENCE_FAILED");
}

function makeAcceptanceEvent(model: S6SpatialModelRecord, prior: S6SpatialModelRecord | null): S6AcceptanceEvent {
  return {
    schemaVersion: "s6-acceptance-event-v1",
    acceptanceEventId: id(50),
    projectId: PROJECT_ID,
    revisionId: model.modelRevisionId,
    revisionHash: model.modelHash,
    sourceS5Fingerprint: HASH,
    priorAcceptedRevisionId: prior?.modelRevisionId ?? null,
    priorAcceptedRevisionHash: prior?.modelHash ?? null,
    actorSubjectId: "subject-1",
    expectedCurrentAcceptedRevisionId: prior?.modelRevisionId ?? null,
    expectedCurrentAcceptedHash: prior?.modelHash ?? null,
    idempotencyKey: id(51),
    requestReferenceId: id(52),
    occurredAt: "2026-09-02T00:00:00.000Z",
  };
}

function makeSupersessionEvent(model: S6SpatialModelRecord, prior: S6SpatialModelRecord, acceptance: S6AcceptanceEvent): S6SupersessionEvent {
  return {
    schemaVersion: "s6-supersession-event-v1",
    supersessionEventId: id(53),
    projectId: PROJECT_ID,
    supersededRevisionId: prior.modelRevisionId,
    supersededRevisionHash: prior.modelHash,
    replacementRevisionId: model.modelRevisionId,
    replacementRevisionHash: model.modelHash,
    sourceS5Fingerprint: HASH,
    acceptanceEventId: acceptance.acceptanceEventId,
    actorSubjectId: "subject-1",
    requestReferenceId: id(54),
    occurredAt: "2026-09-02T00:00:00.000Z",
  };
}

function makeViewArtifact(attempt: 1 | 2, retryOfArtifactId: UUID | null, artifactId: UUID, idempotencyKey: UUID): S6ViewArtifact {
  return {
    schemaVersion: "s6-view-artifact-v1",
    artifactId,
    artifactGroupId: id(70),
    projectId: PROJECT_ID,
    revisionId: id(11),
    revisionHash: HASH,
    sourceS5Fingerprint: HASH,
    viewId: "top-orthographic",
    purpose: "draft_preview",
    rendererVersion: "s6-svg-geometry-v2",
    format: "svg",
    mimeType: "image/svg+xml",
    fileExtension: ".svg",
    fileName: "swooshz-spatial-top-orthographic.svg",
    artifactKey: `projects/${PROJECT_ID}/s6/revisions/${id(11)}/views/top-orthographic/s6-svg-geometry-v2.svg`,
    stagingKey: `projects/${PROJECT_ID}/s6/staging/${id(71)}/${id(72)}/top-orthographic.svg`,
    outputSha256: null,
    outputByteSize: null,
    cameraHash: HASH,
    sceneHash: null,
    preservationReceiptId: null,
    attempt,
    retryOfArtifactId,
    status: "failed_terminal",
    publicationPhase: "aborted",
    workerId: null,
    processId: null,
    claimToken: null,
    claimedAt: null,
    startedAt: null,
    stagedAt: null,
    promotedAt: null,
    completedAt: null,
    terminalAt: "2026-09-02T00:00:00.000Z",
    failureCode: "S6_VIEW_RENDER_FAILURE",
    idempotencyKey,
    requestReferenceId: id(73 + attempt),
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
}

test("legacy state without S6 collections loads empty", () => {
  withRepository(emptyStoreState(), (repository) => {
    const state = repository.state() as unknown as Record<string, unknown>;
    assert.deepEqual(state.s6SpatialModels, []);
    assert.deepEqual(state.s6ValidationReceipts, []);
    assert.deepEqual(state.s6Idempotency, []);
  });
});

test("present malformed S6 collection is rejected", () => {
  assertPersistenceFailure(() => withRepository(stateWith({ s6SpatialModels: "not-an-array" }), () => undefined));
});

test("duplicate revision and broken parent graphs are rejected", () => {
  const first = makeModel();
  assertPersistenceFailure(() => withRepository(stateWith({ s6SpatialModels: [first, clone(first)] }), () => undefined));
  const broken = makeModel({ revision: 2, parentRevision: 99 });
  assertPersistenceFailure(() => withRepository(stateWith({ s6SpatialModels: [first, broken] }), () => undefined));
});

test("child object IDs preserve identity and reject reuse", () => {
  const first = makeModel();
  const child = linkChild(first, makeModel({ revision: 2, parentRevision: 1 }));
  withRepository(stateWith({ s6SpatialModels: [first, child] }), (repository) => {
    assert.equal(repository.state().s6SpatialModels.length, 2);
  });
  const reused = linkChild(first, makeModel({ revision: 2, parentRevision: 1, identityKey: "different-logical-object" }));
  assertPersistenceFailure(() => withRepository(stateWith({ s6SpatialModels: [first, reused] }), () => undefined));
});

test("malformed geometry/designFormReview exact keys are rejected", () => {
  const malformedGeometry = makeModel();
  (malformedGeometry.objects[0]!.primitive as unknown as Record<string, unknown>).holes = [];
  assertPersistenceFailure(() => withRepository(stateWith({ s6SpatialModels: [malformedGeometry] }), () => undefined));
  const malformedReview = makeModel();
  (malformedReview.designFormReview as unknown as Record<string, unknown>).extra = true;
  assertPersistenceFailure(() => withRepository(stateWith({ s6SpatialModels: [malformedReview] }), () => undefined));
});

test("only one current accepted revision exists and supersession is recorded", () => {
  const first = makeModel({ status: "accepted_current" });
  const second = makeModel({ revision: 2, parentRevision: 1, status: "accepted_current" });
  assertPersistenceFailure(() => withRepository(stateWith({ s6SpatialModels: [first, second] }), () => undefined));

  const superseded = makeModel({ status: "superseded" });
  superseded.supersededAt = "2026-09-02T00:00:00.000Z";
  const accepted = linkChild(superseded, makeModel({ revision: 2, parentRevision: 1, status: "accepted_current" }));
  const acceptance = makeAcceptanceEvent(accepted, superseded);
  accepted.acceptanceEventId = acceptance.acceptanceEventId;
  accepted.acceptedAt = "2026-09-02T00:00:00.000Z";
  const supersession = makeSupersessionEvent(accepted, superseded, acceptance);
  withRepository(stateWith({
    s6SpatialModels: [superseded, accepted],
    s6AcceptanceEvents: [acceptance],
    s6SupersessionEvents: [supersession],
  }), (repository) => assert.equal(repository.state().s6AcceptanceEvents.length, 1));
});

test("artifact attempts/retries/idempotency keys form a valid graph", () => {
  const model = makeModel();
  const firstArtifact = makeViewArtifact(1, null, id(80), id(81));
  const retryArtifact = makeViewArtifact(2, firstArtifact.artifactId, id(82), id(83));
  firstArtifact.revisionHash = model.modelHash;
  retryArtifact.revisionHash = model.modelHash;
  const valid = stateWith({ s6SpatialModels: [model], s6ViewArtifacts: [firstArtifact, retryArtifact] });
  withRepository(valid, (repository) => assert.equal(repository.state().s6ViewArtifacts.length, 2));
  const gap = stateWith({ s6SpatialModels: [model], s6ViewArtifacts: [retryArtifact] });
  assertPersistenceFailure(() => withRepository(gap, () => undefined));
  const reusedKey = stateWith({
    s6Idempotency: [
      { schemaVersion: "s6-idempotency-v1", key: id(90), operation: "generation", projectId: PROJECT_ID, inputHash: HASH, sourceS5Fingerprint: HASH, result: {}, createdAt: "2026-09-02T00:00:00.000Z" },
      { schemaVersion: "s6-idempotency-v1", key: id(90), operation: "generation", projectId: PROJECT_ID, inputHash: "b".repeat(64), sourceS5Fingerprint: HASH, result: {}, createdAt: "2026-09-02T00:00:00.000Z" },
    ],
  });
  assertPersistenceFailure(() => withRepository(reusedKey, () => undefined));
});

test("S6 persistence remains compatible with the typed StoreState boundary", () => {
  const state = stateWith() as unknown as StoreState;
  assert.equal(Array.isArray((state as unknown as Record<string, unknown>).s6SpatialModels), true);
});
