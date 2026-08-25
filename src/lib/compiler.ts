import type {
  CandidateDirection,
  CompilerMetadata,
  UserConfirmedBrief,
} from "./types";
import { cloneJson, jcs, nowUtc, quote, sha256 } from "./utils";

export const COMPILER_VERSION = "g2-booth-v1" as const;
export const IMAGE_MODEL_SNAPSHOT = "gpt-image-2-2026-04-21" as const;
export const CAMERA_INTENT = "landscape 3/4 eye-level exhibition-booth hero" as const;
export const HARD_CONSTRAINT_TEXT =
  "Fit the booth inside the confirmed width and depth; keep every open side visibly open and accessible; respect max height when supplied; use plausible circulation, readable scale, stable-looking elements, realistic support, and coherent materials; this is visual screening only and is not engineering, fabrication, structural, fire, accessibility, code, or venue approval.";
export const BUILDABILITY_BOUNDARY =
  "Visual screening only; no engineering, fabrication, structural, fire, accessibility, code, or venue approval.";
export const OUTPUT_INSTRUCTION =
  "Create one landscape exhibition-booth concept image; do not add a second view, plan, technical drawing, dimensions, certification, or approval claim.";

export const DIRECTIONS: readonly {
  candidateIndex: 1 | 2 | 3 | 4;
  key: CandidateDirection;
  instruction: string;
}[] = [
  {
    candidateIndex: 1,
    key: "modular-clarity",
    instruction:
      "Explore a clean modular composition with a legible hierarchy, disciplined circulation, and repeatable-looking components.",
  },
  {
    candidateIndex: 2,
    key: "brand-theatre",
    instruction:
      "Explore a strong focal brand moment with memorable vertical or overhead emphasis while keeping support functions plausible.",
  },
  {
    candidateIndex: 3,
    key: "open-demo",
    instruction:
      "Explore an outward-facing demonstration layout that makes visitor access, activity, and product interaction immediately readable.",
  },
  {
    candidateIndex: 4,
    key: "hospitality-consultation",
    instruction:
      "Explore a welcoming reception and consultation composition with calm seating logic and an approachable human scale.",
  },
];

function compilerData(brief: UserConfirmedBrief): UserConfirmedBrief["data"] {
  const data = cloneJson(brief.data);
  delete (data as Partial<UserConfirmedBrief["data"]>).extractedGeometryMentions;
  return data;
}

export function canonicalCompilerInput(brief: UserConfirmedBrief): Record<string, unknown> {
  return {
    schemaVersion: brief.schemaVersion,
    geometrySnapshot: brief.geometrySnapshot,
    data: compilerData(brief),
    compilerVersion: COMPILER_VERSION,
    imageModelSnapshot: IMAGE_MODEL_SNAPSHOT,
    directionKeys: DIRECTIONS.map((direction) => direction.key),
  };
}

export function compilerInputHash(brief: UserConfirmedBrief): string {
  return sha256(jcs(canonicalCompilerInput(brief)));
}

export function compilePrompt(
  brief: UserConfirmedBrief,
  direction: (typeof DIRECTIONS)[number],
  compiledAt: string = nowUtc(),
): { promptText: string; compilerMetadata: CompilerMetadata } {
  const canonicalInputHash = compilerInputHash(brief);
  const lines = [
    "[CONTEXT]",
    `schemaVersion=${jcs(brief.schemaVersion)}`,
    `projectFacts=${jcs(brief.data.projectFacts)}`,
    "[HARD_GEOMETRY]",
    `widthMm=${String(brief.geometrySnapshot.widthMm)}`,
    `depthMm=${String(brief.geometrySnapshot.depthMm)}`,
    `openSides=${jcs(brief.geometrySnapshot.openSides)}`,
    `maxHeightMm=${jcs(brief.geometrySnapshot.maxHeightMm)}`,
    `hardConstraintText=${quote(HARD_CONSTRAINT_TEXT)}`,
    "[FUNCTIONAL_REQUIREMENTS]",
    `functionalRequirements=${jcs(brief.data.functionalRequirements)}`,
    `mandatoryRequirements=${jcs(brief.data.mandatoryRequirements)}`,
    `budget=${jcs(brief.data.budget)}`,
    `freeTextRequirements=${jcs(brief.data.freeTextRequirements)}`,
    "[BRAND_STYLE]",
    `brandStyle=${jcs(brief.data.brandStyle)}`,
    "[CREATIVE_DIRECTION]",
    `directionKey=${quote(direction.key)}`,
    `directionInstruction=${quote(direction.instruction)}`,
    "[PRESENTATION_INTENT]",
    `cameraIntent=${quote(CAMERA_INTENT)}`,
    "[PROHIBITIONS_AND_UNKNOWN_HANDLING]",
    `prohibitedRequirements=${jcs(brief.data.prohibitedRequirements)}`,
    `unknowns=${jcs(brief.data.unknowns)}`,
    `assumptions=${jcs(brief.data.assumptions)}`,
    `buildabilityBoundary=${quote(BUILDABILITY_BOUNDARY)}`,
    "[OUTPUT_INSTRUCTION]",
    `outputInstruction=${quote(OUTPUT_INSTRUCTION)}`,
  ];
  const promptText = lines.join("\n");
  return {
    promptText,
    compilerMetadata: {
      compilerVersion: COMPILER_VERSION,
      directionKey: direction.key,
      canonicalInputHash,
      promptHash: sha256(promptText),
      compiledAt,
    },
  };
}

export function promptManifestHash(promptHashes: string[]): string {
  return sha256(jcs(promptHashes));
}
