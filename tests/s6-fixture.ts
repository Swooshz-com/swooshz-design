import { randomUUID } from "node:crypto";
import { compileConceptLayoutPlan } from "../src/lib/s5-layout";
import { s6SourceFingerprint } from "../src/lib/s6-source";
import type {
  BoothGeometry,
  S2Requirement,
  S5LayoutRequirement,
  S5ToS6Projection,
  UUID,
} from "../src/lib/types";

const HASH = "a".repeat(64);
const AT = "2026-09-02T00:00:00.000Z";

export type S6SourceOptions = {
  widthMm?: number;
  depthMm?: number;
  openSides?: BoothGeometry["openSides"];
  maxHeightMm?: number | null;
  requirements?: Array<{
    name: string;
    details?: string | null;
    expected?: S2Requirement["expected"];
    expectedCount?: number | null;
    category?: S2Requirement["category"];
    criticality?: S2Requirement["criticality"];
  }>;
  preferredColors?: string[];
  materials?: string[];
  visualDirection?: string | null;
};

function id(index: number): UUID {
  return "20000000-0000-4000-8000-" + String(index).padStart(12, "0") as UUID;
}

function layoutRequirement(index: number, value: NonNullable<S6SourceOptions["requirements"]>[number]): S5LayoutRequirement {
  const expected = value.expected ?? (value.expectedCount === undefined || value.expectedCount === null ? "present" : "exact_count");
  const countIsExact = expected === "exact_count";
  return {
    requirementId: ("brief.functional." + String(index).padStart(3, "0")) as S5LayoutRequirement["requirementId"],
    name: value.name,
    details: value.details ?? null,
    mandatory: true,
    count: countIsExact ? value.expectedCount ?? 0 : null,
    countIsExact,
  };
}

export function makeS6Source(options: S6SourceOptions = {}): S5ToS6Projection {
  const geometrySnapshot: BoothGeometry = {
    widthMm: options.widthMm ?? 6000,
    depthMm: options.depthMm ?? 3000,
    openSides: options.openSides ?? ["north", "east"],
    maxHeightMm: options.maxHeightMm === undefined ? 3000 : options.maxHeightMm,
  };
  const requested = options.requirements ?? [
    { name: "Welcome counter", details: "Reception counter", expected: "present" },
    { name: "Demo table", details: "Product demo table", expected: "exact_count", expectedCount: 2 },
  ];
  const layoutRequirements = requested.map((value, index) => layoutRequirement(index + 1, value));
  const canonicalRequirements: S2Requirement[] = requested.map((value, index) => {
    const layout = layoutRequirements[index]!;
    return {
      requirementId: layout.requirementId,
      category: value.category ?? "functional",
      expected: layout.countIsExact ? "exact_count" : value.expected ?? "present",
      expectedCount: layout.countIsExact ? layout.count : null,
      expectedValue: value.name,
      criticality: value.criticality ?? "material",
      source: "confirmed_brief",
      text: value.details ? value.name + ": " + value.details : value.name,
    };
  });
  const projectId = id(1);
  const generationSetId = id(2);
  const selectionStateId = id(3);
  const activeRevisionId = id(4);
  const approvalEventId = id(5);
  const layoutPlan = compileConceptLayoutPlan({
    projectId,
    generationSetId,
    selectionStateId,
    selectionVersion: 1,
    activeRevisionId,
    activeRevisionKind: "s3_source",
    approvalEventId,
    approvalGeneration: 1,
    approvalEventSequence: 1,
    geometry: geometrySnapshot,
    requirements: layoutRequirements,
  });
  const source: S5ToS6Projection = {
    schemaVersion: "s5-to-s6-projection-v1",
    readOnly: true,
    readiness: "ready",
    projectId,
    generationSetId,
    selectionStateId,
    selectionVersion: 1,
    approvalEventId,
    approvalGeneration: 1,
    eventSequence: 1,
    generationContextHash: HASH,
    activeRevisionId,
    activeRevisionKind: "s3_source",
    sourceSnapshotId: id(6),
    lineageRootRevisionId: id(6),
    sourceBindingHash: HASH,
    quality: "PASS",
    activeAsset: { assetId: id(7), storageKey: "projects/" + projectId + "/hero.png", sha256: HASH, byteSize: 10, width: 1536, height: 1024, pixelCount: 1572864 },
    confirmedBriefVersionId: id(8),
    briefContentHash: HASH,
    geometrySnapshot,
    geometryHash: HASH,
    canonicalRequirements,
    requirementHash: HASH,
    layoutRequirements,
    layoutRequirementsHash: HASH,
    designRulesVersion: "s2-design-rules-v1",
    designRuleSnapshot: [],
    designRuleSnapshotHash: HASH,
    presentationFacts: { projectName: "S6 fixture", clientName: "Client", eventName: "Event", venueName: "Venue", eventLocation: "Singapore", eventStartDate: null, eventEndDate: null },
    visualIntent: {
      brandName: "Fixture brand",
      visualDirection: options.visualDirection ?? "bounded exhibition form",
      preferredColors: options.preferredColors ?? ["#336699"],
      materials: options.materials ?? ["wood_like", "metal_like", "fabric_like"],
      logoInstructions: null,
      source: "confirmed_brief",
      sourceHash: HASH,
    },
    layoutPlan,
    layoutArtifacts: {
      planJson: { artifactId: id(9), sha256: HASH, byteSize: 10, rendererVersion: "s5-concept-layout-v1", status: "committed" },
      planSvg: { artifactId: id(10), sha256: HASH, byteSize: 10, rendererVersion: "s5-layout-svg-v1", status: "committed" },
    },
    presentationArtifact: { artifactId: id(11), sha256: HASH, byteSize: 10, pageCount: 5, rendererVersion: "s5-presentation-pdf-v1", status: "committed" },
    sourceFingerprint: HASH,
  };
  source.sourceFingerprint = s6SourceFingerprint(source);
  return source;
}

export function allNonEmptyOpenSideSubsets(): BoothGeometry["openSides"][] {
  const sides = ["north", "east", "south", "west"] as const;
  const subsets: BoothGeometry["openSides"][] = [];
  for (let mask = 1; mask < 16; mask += 1) {
    subsets.push(sides.filter((_side, index) => (mask & (1 << index)) !== 0));
  }
  return subsets;
}

export function deterministicRevisionId(index: number): UUID {
  return id(100 + index);
}

export function deterministicClock(): () => string {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.parse(AT) + tick).toISOString();
  };
}

export function representativeSources(): Record<string, S5ToS6Projection> {
  return {
    "mixed-open-sides-angled-partition": makeS6Source({
      requirements: [
        { name: "Angled fabric partition", details: "Non-axis-aligned partition", expected: "present" },
        { name: "Welcome counter", details: "Reception counter", expected: "present" },
      ],
    }),
    "round-counter": makeS6Source({
      requirements: [{ name: "Round metallic counter", details: "Circular reception counter", expected: "exact_count", expectedCount: 1 }],
    }),
    "extruded-non-rectangular-feature": makeS6Source({
      widthMm: 8000,
      depthMm: 4000,
      requirements: [{ name: "L-profile display fascia", details: "Non-rectangular profile extrusion", expected: "present" }],
    }),
    "overhead-profile": makeS6Source({
      widthMm: 8000,
      depthMm: 4000,
      openSides: ["south", "west"],
      requirements: [{ name: "Stepped overhead profile", details: "Profile fascia overhead volume", expected: "present" }],
    }),
    "material-finish-variation": makeS6Source({
      materials: ["wood_like counter", "fabric_like partition", "metal_like screen", "glass_like display", "brand_reference overhead"],
      requirements: [
        { name: "Wood counter", expected: "present" },
        { name: "Fabric partition", expected: "present" },
        { name: "Metal screen", expected: "present" },
        { name: "Glass display", expected: "present" },
        { name: "Brand overhead", expected: "present" },
      ],
    }),
    "mixed-form-booth-continuity": makeS6Source({
      widthMm: 9000,
      depthMm: 5000,
      openSides: ["north", "south"],
      maxHeightMm: null,
      requirements: [
        { name: "Round counter", expected: "present" },
        { name: "Angled partition", expected: "present" },
        { name: "Profile overhead", expected: "present" },
      ],
    }),
    "unsupported-form-fails-closed": makeS6Source({
      visualDirection: "curved double-bent wall with a hole; unsupported free-form shape",
      requirements: [{ name: "Curved double-bent wall with a hole", details: "unsupported form", expected: "present" }],
    }),
  };
}

export function freshReferenceId(): UUID {
  return randomUUID() as UUID;
}
