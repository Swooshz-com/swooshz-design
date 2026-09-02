import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { AppError, type S5ToS6Projection, type UUID } from "../src/lib/types";
import { sha256 } from "../src/lib/utils";
import { createS6SourceReader, s6SourceFingerprint } from "../src/lib/s6-source";
import { cleanupS5Fixture, createS5Fixture, makeS5Ready } from "./s5-fixture";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof AppError && error.code === code);
}

let fixture: Awaited<ReturnType<typeof createS5Fixture>>;
let projection: S5ToS6Projection;

test.before(async () => {
  fixture = await createS5Fixture();
  await makeS5Ready(fixture);
  const approval = fixture.service.s5.approve(fixture.projectId, fixture.service.s5.getFence(fixture.projectId), randomUUID() as UUID, randomUUID() as UUID);
  assert.equal(approval.approval.status, "approved");
  fixture.service.s5.generateLayout(fixture.projectId, fixture.service.s5.getFence(fixture.projectId), randomUUID() as UUID, randomUUID() as UUID);
  await fixture.service.s5.generatePresentation(fixture.projectId, fixture.service.s5.getFence(fixture.projectId), randomUUID() as UUID, randomUUID() as UUID);
  projection = fixture.service.s5.getS6ReadOnlyProjection(fixture.projectId);
});

test.after(() => {
  cleanupS5Fixture(fixture);
});

test("ready S5 projection contains the exact typed fields including the approved asset ID/hash used by design-form review", () => {
  assert.equal(projection.schemaVersion, "s5-to-s6-projection-v1");
  assert.equal(projection.readOnly, true);
  assert.equal(projection.readiness, "ready");
  assert.equal(projection.projectId, fixture.projectId);
  assert.equal(projection.activeAsset.width, 1536);
  assert.equal(projection.activeAsset.height, 1024);
  assert.equal(projection.activeAsset.pixelCount, 1572864);
  assert.match(projection.activeAsset.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(projection.designRulesVersion, "s2-design-rules-v1");
  assert.equal(projection.layoutArtifacts.planJson.status, "committed");
  assert.equal(projection.layoutArtifacts.planSvg.status, "committed");
  assert.equal(projection.presentationArtifact.status, "committed");
});

test("S5 plan coordinates remain conceptual and are not metric compiler inputs", () => {
  assert.equal(projection.layoutPlan.coordinateConvention.displaySpace, "normalized-Q16-conceptual");
  const instance = projection.layoutPlan.zones.flatMap((zone) => zone.instances)[0];
  assert.ok(instance);
  assert.equal(typeof instance?.xQ16, "number");
  assert.equal(typeof instance?.widthQ16, "number");
  assert.notEqual(instance?.xQ16, projection.geometrySnapshot.widthMm);
});

test("PDF and storage-key churn does not change source fingerprint", () => {
  const variants = new Map<string, S5ToS6Projection>([[fixture.projectId, clone(projection)]]);
  const reader = createS6SourceReader(fixture.repository, fixture.objects, (projectId) => clone(variants.get(projectId)!));
  const baseline = reader.currentFingerprint(fixture.projectId);
  const churned = clone(projection);
  churned.activeAsset.storageKey = "projects/" + fixture.projectId + "/moved-hero.png";
  churned.layoutArtifacts.planJson.artifactId = randomUUID() as UUID;
  churned.layoutArtifacts.planJson.sha256 = "b".repeat(64);
  churned.layoutArtifacts.planJson.byteSize += 7;
  churned.presentationArtifact.artifactId = randomUUID() as UUID;
  churned.presentationArtifact.sha256 = "c".repeat(64);
  churned.presentationArtifact.byteSize += 11;
  churned.presentationArtifact.pageCount += 1;
  variants.set(fixture.projectId, churned);
  assert.equal(reader.currentFingerprint(fixture.projectId), baseline);
});

test("geometry, requirements, hero, and approval changes change source fingerprint", () => {
  const variants = new Map<string, S5ToS6Projection>([[fixture.projectId, clone(projection)]]);
  const reader = createS6SourceReader(fixture.repository, fixture.objects, (projectId) => clone(variants.get(projectId)!));
  const baseline = reader.currentFingerprint(fixture.projectId);
  const changes: Array<(value: S5ToS6Projection) => void> = [
    (value) => { value.geometrySnapshot.widthMm += 100; },
    (value) => { value.canonicalRequirements = [...value.canonicalRequirements, clone(value.canonicalRequirements[0]!)]; },
    (value) => { value.activeAsset.sha256 = "d".repeat(64); },
    (value) => { value.approvalGeneration += 1; },
    (value) => { value.layoutPlan.planHash = "e".repeat(64); },
  ];
  for (const change of changes) {
    const variant = clone(projection);
    change(variant);
    variant.sourceFingerprint = s6SourceFingerprint(variant);
    variants.set(fixture.projectId, variant);
    assert.notEqual(reader.currentFingerprint(fixture.projectId), baseline);
  }
});

test("non-ready S5 is refused", () => {
  const reader = createS6SourceReader(fixture.repository, fixture.objects, () => {
    throw new AppError(409, "S6_SOURCE_NOT_READY");
  });
  expectCode(() => reader.readReady(fixture.projectId), "S6_SOURCE_NOT_READY");
});

test("source fence rejects at generation draft correction acceptance render publication and download boundaries", () => {
  let current = clone(projection);
  const reader = createS6SourceReader(fixture.repository, fixture.objects, () => clone(current));
  const baseline = reader.currentFingerprint(fixture.projectId);
  assert.equal(reader.assertCurrent(fixture.projectId, baseline).sourceFingerprint, baseline);
  current.activeAsset.sha256 = sha256("changed approved asset");
  current.sourceFingerprint = s6SourceFingerprint(current);
  for (const boundary of ["generation draft", "correction", "acceptance", "render", "publication", "download"]) {
    assert.throws(() => reader.assertCurrent(fixture.projectId, baseline), (error: unknown) => error instanceof AppError && error.code === "S6_SOURCE_STALE", boundary);
  }
});
