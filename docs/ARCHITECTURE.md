# MVP Architecture

## Architecture principle
Build one small deployable web application. Do not introduce microservices, 3D infrastructure or enterprise platform abstractions in v0.1.

## Proposed stack
- Web application: Next.js + React + TypeScript.
- Server/API: Next.js server-side routes/actions for the MVP unless a concrete provider integration requires a separate worker.
- Database: PostgreSQL.
- Object storage: S3-compatible storage for source documents and generated assets.
- Background work: Minimal job abstraction for AI calls that may exceed request lifetimes; choose the simplest deployable queue supported by the selected hosting stack.
- PDF generation: Server-side deterministic HTML/template-to-PDF path.
- AI providers: One selected production provider for v0.1 behind narrow internal interfaces.

The exact hosting/database vendor is a G2 implementation choice provided it does not change these trust or product boundaries.

## Source of truth
The source of truth is structured project/revision data, not generated image pixels alone.

### Project
Stores:
- Project identity/name.
- Booth dimensions.
- Open-side orientation.
- Optional max height/budget/venue.
- Current confirmed structured brief version.
- Source asset references.
- Selected/locked hero revision reference.

### Brief version
Immutable snapshot of:
- Extracted requirements.
- User corrections.
- Unknowns/assumptions.
- Functional counts.
- Brand/style/prohibited constraints.

A new material brief edit creates a new version; old generated revisions remain bound to the version that produced them.

### Concept/revision
Every concept image or edit is immutable and stores:
- Project ID.
- Parent revision ID if applicable.
- Brief version ID.
- Operation: initial-generation / repair / refinement / local-edit.
- Prompt compiler version.
- Provider/model identifier.
- Asset reference.
- QA result/reference.
- Timing/cost metadata where available.

Never overwrite image assets in-place.

## AI boundary interfaces
Keep the first implementation narrow:

```ts
interface BriefAI {
  extractBrief(input: BriefExtractionInput): Promise<StructuredBriefResult>
}

interface ImageAI {
  generateConcepts(input: ConceptGenerationInput): Promise<GeneratedConcept[]>
  editRegion(input: RegionEditInput): Promise<GeneratedImage>
}

interface VisionQA {
  reviewConcept(input: ConceptReviewInput): Promise<ConceptReview>
}

interface LayoutAI {
  generateConceptLayout(input: LayoutGenerationInput): Promise<ConceptLayoutResult>
}
```

These are internal product boundaries, not a requirement to support multiple providers in v0.1.

## Prompt compiler
The prompt compiler is deterministic application code/configuration that combines:
- Confirmed booth geometry/open sides.
- Structured functional brief.
- Brand/style requirements.
- `DESIGN_RULES.md` rule subset appropriate to the operation.
- Camera/presentation intent.
- Prohibitions/negative constraints.

Store a compiler version with every generated revision.

## Initial concept generation
- One generation set requests exactly four candidates.
- Candidate prompts may vary creative direction but must share hard constraints.
- Store each candidate before QA.
- QA runs independently against each candidate and the same brief version.

## QA / repair flow
```text
candidate
  ↓
vision QA against brief + design rules
  ↓
PASS / WARNING / MATERIAL_FAIL
  ↓
if MATERIAL_FAIL and repair_count == 0:
  targeted repair generation
  ↓
re-review
  ↓
show result + status
```

No autonomous repeated repair loops.

## Local edit flow
```text
locked/source revision
  + user mask
  + edit instruction
        ↓
masked provider edit
        ↓
protected-region comparison
        ↓
accept as child revision OR reject/flag drift
```

### Protected-region comparison
MVP goal is pragmatic protection, not perfect perceptual equivalence.

Implementation may combine:
- Pixel/perceptual difference outside the expanded edit mask.
- Vision-model check for material changes to named protected objects/architecture.

G2 must define thresholds/failure behaviour before implementation.

## Concept Layout Plan
The plan is a derived concept asset, not a CAD source of truth.

Inputs:
- Confirmed brief version.
- Booth dimensions/open sides.
- Locked hero image.

Outputs:
- Booth boundary/dimensions.
- Named zone placements.
- Approximate furniture/equipment footprints.
- Main circulation indication.
- `Concept Layout Plan` label/disclaimer.

If reliable exact dimension drawing cannot be produced by the chosen AI path within MVP time, deterministic booth boundary/dimension graphics should wrap an AI/structured zone layout rather than allowing arbitrary plan geometry.

## Presentation PDF
Build deterministically from stored project data/assets. Do not ask an image model to render an entire presentation board containing critical exact text.

Minimum sections:
- Project facts.
- Final hero.
- Concept Layout Plan.
- Design summary.
- Concept-stage disclaimer.

## Storage/security
- Never place provider keys in repository content or client-side bundles.
- Environment variable names may be documented; values never are.
- Validate uploaded file type/size.
- Use generated object keys rather than trusting user filenames as storage paths.
- Source and generated assets should not be public by default at the storage layer even if the repository itself is public.
- Avoid logging uploaded document contents or secrets unnecessarily.

## Failure posture
- Provider/API failure: Preserve project/revision state and expose retry; do not create a fake success asset.
- Extraction uncertainty: Surface unknowns for user confirmation; do not silently invent critical dimensions/open sides.
- QA failure: Show status and at most one automated repair attempt.
- Local edit drift: Reject/flag rather than silently replacing the source.
- PDF failure: Keep approved assets intact and permit deterministic retry.

## Observability
For each AI operation capture:
- Operation type.
- Provider/model identifier.
- Start/end timestamps.
- Success/failure category.
- Usage/cost metadata if provider exposes it.
- Project/revision IDs.

Do not log secret values.

## First implementation vertical slice
The first slice intentionally stops before editing/PDF:

`create project → mandatory booth geometry → upload one brief → structured extraction → user-confirmed brief → compile prompt → generate four concepts → persist candidates`

This slice proves the product's core value before adding QA and editing complexity.

## G2 entry criteria
G2 may begin when G1 is accepted and must contract, at minimum:
- Exact first vertical-slice routes/screens.
- Database entities/fields required by that slice.
- Upload file limits/types.
- Selected AI provider and exact API capabilities used.
- Structured brief schema.
- Prompt compiler input/output contract.
- Four-candidate generation semantics.
- Persistence/idempotency/error behaviour.
- Required tests.
- Secrets/environment variable names only; no values.

## G2 must not add
- 3D/Autodesk/Max.
- Costing.
- Venue databases.
- Billing.
- Multi-provider routing.
- Any feature outside `MVP_SCOPE.md` without explicit owner/Web scope expansion.

## ELI5
Keep one simple app. Store the booth requirements and every image revision properly. AI creates and checks images, but the database remembers exactly which brief and rules created each one. Build the basic `brief → four concepts` path first; add editing and PDF only after that works.
