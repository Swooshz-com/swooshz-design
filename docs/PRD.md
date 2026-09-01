# Swooshz Design Full-Suite MVP PRD

## Product
AI Exhibition Design Copilot for exhibition contractors and design houses.

## Problem
Exhibition teams receive booth briefs but often need substantial design time and specialist tooling to turn them into coherent concepts, client presentations, editable plans and 3D production handoffs. Generic image models can generate attractive images but frequently drift on dimensions, open sides, object counts, support logic and cross-view consistency.

## MVP promise
Turn one confirmed exhibition-booth brief into a coherent design package: strong concept visuals, an approved spatial design, consistent additional views, editable 2D CAD, editable 3D and a 3ds Max-compatible handoff — without requiring the user to become an AI prompting specialist.

## Target user
Primary: sales/design staff at exhibition contractors and design houses who need to move quickly from client brief to a credible design package that can continue into normal design-production workflows.

## Primary journey
1. Create project.
2. Enter mandatory booth width and depth.
3. Select the number/location of open sides with explicit orientation.
4. Optionally enter maximum height, budget and venue/exhibition context.
5. Upload brief PDF, reference images and logo/brand assets.
6. System extracts an editable structured brief.
7. User confirms/corrects extracted requirements and unknowns.
8. System generates four concept candidates from the same confirmed hard constraints.
9. System performs requirement/buildability-aware visual QA and at most one bounded automatic repair per material failure.
10. User selects a concept and may run bounded refinement and masked local edits with preservation validation.
11. User locks a final hero revision.
12. System generates the S5 Concept Layout Plan and client presentation PDF.
13. System creates one canonical spatial-design model from confirmed project facts plus approved design intent.
14. User reviews/corrects or explicitly accepts the spatial model revision.
15. System produces coherent additional camera views tied to that exact spatial revision.
16. System derives an accurate editable 2D CAD handoff from that same spatial revision.
17. System derives an editable 3D model and a proven 3ds Max-compatible handoff from that same spatial revision.
18. User downloads the complete design package.
19. Final UAT verifies that the booth remains materially the same design from brief through views, CAD and 3D.

## Mandatory project inputs
- Booth width.
- Booth depth.
- Number/location of open sides.

## Optional project inputs
- Maximum height.
- Budget.
- Exhibition/venue name.
- Free-text requirements.
- PDF brief.
- Reference images.
- Logo/brand assets.

## Structured brief minimum fields
- Booth dimensions.
- Open-side orientation.
- Maximum height if known.
- Budget if known.
- Required functional zones and exact counts when stated.
- Presentation/display requirements.
- Storage requirements.
- Furniture/activity requirements.
- Brand/style requirements.
- Prohibited references/assets.
- Material unknowns/assumptions requiring user confirmation.

## Concept-generation stage
- Generate exactly four distinct initial design directions per generation set.
- Every candidate receives the same confirmed structured brief and booth-rule package.
- Prompt implementation is internal; users should not need to author specialist prompts.
- One image provider is sufficient for the MVP concept path unless a later accepted gate explicitly expands it.
- Every generated or edited image revision is immutable and retains its brief/compiler/provider/QA lineage.

## Visual QA and bounded repair
At minimum check for materially observable issues such as:
- Required functional zones/counts missing where reasonably observable.
- Objects obviously extending outside the booth footprint.
- Implausible unsupported overhead architecture.
- Unsupported screens/large fixtures.
- Implausible furniture/equipment scale.
- Blocked primary entrances/open sides.
- Material brand/style failures.
- Prohibited IP/branding violations.

QA is concept-level design/buildability screening, not engineering certification. Material failures may receive at most one automatic repair attempt in the accepted concept-stage path.

## Selection, refinement and local editing
- Selected/source revisions remain immutable.
- Targeted refinements create child revisions.
- Local editing uses a user rectangle/brush mask plus instruction.
- Protected/non-mask regions are checked before accepting the edit.
- Material protected-region drift is rejected/flagged.
- Prior revisions remain selectable for undo/recovery.

## Final hero and S5 concept outputs
The approved final hero, Concept Layout Plan and client PDF are canonical S5 outputs and remain an upstream foundation for the later full-suite design-production stages.

The Concept Layout Plan is concept-stage planning evidence only; it is not fabrication CAD and must not be treated as the geometric source of truth for S6-S8.

## Canonical spatial-design model
After S5, the MVP creates one immutable, versioned spatial model that becomes the geometric source of truth for all downstream design-production outputs.

At minimum it must represent, subject to accepted S6 G1/G2 contracts:
- Millimetre project units and a stable world coordinate system.
- Exact confirmed booth footprint and open-side boundaries.
- Known maximum height where confirmed.
- Modeled walls, partitions, architectural volumes and overhead elements.
- Named functional zones.
- Major modeled furniture, displays, counters, screens and equipment.
- Stable object identity, semantic role and parent/child hierarchy.
- Position, rotation, scale and asserted dimensions.
- Material/finish/brand references where known.
- Provenance for material geometry.
- Explicit assumptions/unknowns instead of fabricated precision.
- Immutable revision lineage and acceptance state.

Authority order is:
1. User-confirmed hard project facts.
2. User-confirmed structured requirements/counts.
3. Accepted canonical spatial-model revision.
4. Downstream artifacts derived from that revision.
5. Hero/reference imagery for visual/design intent.
6. Bounded AI inference only where explicitly represented as a design assumption/decision.

Generated image pixels never silently override confirmed dimensions, open sides, counts or accepted geometry.

## Spatial review/correction
Before CAD export, the user must be able to review/correct material spatial errors or explicitly accept the spatial-model revision.

The MVP does not require a complete browser CAD application. The accepted implementation should use the smallest usable correction interaction, such as bounded object selection, property editing, move/resize/rotate controls or another G1/G2-proven mechanism.

Material corrections create a new immutable spatial revision rather than overwriting accepted history.

## Coherent additional views
Additional camera views must be generated from or strongly conditioned by the accepted canonical spatial model.

They must preserve material geometry including:
- Booth footprint and open sides.
- Major walls/partitions/volumes.
- Major object identity and placement.
- Relative scale within accepted tolerances.
- Material overhead architecture/support intent.

The preferred approach is geometry-backed rendering, optionally followed by bounded appearance enhancement. Independent free-form image generations that merely imitate the hero are not acceptable as final geometric multi-angle truth.

## Editable 2D CAD handoff
The MVP must derive an editable 2D plan from the accepted spatial revision.

Required outcome includes:
- Millimetre units.
- Booth boundary/dimensions.
- Open-side geometry.
- Modeled walls/partitions.
- Named zones.
- Major modeled equipment/furniture/display footprints.
- Useful layer/object semantics and dimensions/labels.
- Successful import/opening in representative AutoCAD-compatible tooling.

DXF is the mandatory interoperability baseline unless S7 G1/G2 proves another open/testable editable format is a better minimum-sufficient choice. Native DWG is desirable but is not required without a licensed, reliable and testable generation/conversion path.

## Editable 3D and 3ds Max-compatible handoff
The editable 3D scene must derive from the same canonical spatial revision and preserve useful world scale, major geometry, object hierarchy/names, transforms, material assignments/references where supported and view/camera definitions where useful.

The MVP requires a production-useful handoff that can be imported into 3ds Max with editable geometry and preserved major dimensions/hierarchy.

Native `.max` is not mandatory unless S8 G1/G2 proves a licensed, deterministic and supportable automation path. FBX or another proven 3ds Max-importable editable format may satisfy the MVP contract.

## Cross-output consistency
For one accepted spatial revision, coherent views, CAD, editable 3D and the 3ds Max handoff must agree on material geometry within explicit tolerances.

At minimum compare:
- Outer booth dimensions.
- Open-side orientation.
- Major wall/partition positions.
- Major object identity/count.
- Major object placements.
- Overhead architecture where modeled.
- Functional-zone relationships.

A material spatial revision makes earlier downstream artifacts stale. Stale artifacts must not continue to present themselves as current.

## Presentation/download package
The complete MVP package contains the applicable approved outputs for the project, including concept-stage presentation assets and downstream design-production files. Artifacts are private by default, bound to exact source revisions and served only after authorization/integrity checks.

## Product telemetry
Record enough durable-source telemetry to evaluate viability without fabricating unavailable values, including where applicable:
- Generation/queue latency.
- Provider cost only where durably exposed.
- QA failures and bounded repair results.
- Revision/refinement/local-edit counts and outcomes.
- Time to accepted concept/final hero.
- Spatial-model correction/acceptance activity.
- Coherent-view consistency failures.
- CAD export/import success and dimensional consistency.
- 3D/3ds Max handoff success and degradation/failure categories.
- End-to-end time to completed design package.

## MVP non-goals
Unless separately authorised later, the MVP does not include:
- Structural engineering calculations/certification.
- Fabrication/shop drawings or construction sign-off.
- Venue approval or automated venue-rule compliance.
- Costing/BOM/quotation.
- Supplier catalogue.
- Billing/subscriptions.
- CRM/project-management suite.
- White-label/enterprise permission systems.
- Multi-provider marketplace/automatic provider routing.

Autodesk APS is optional infrastructure only and must be justified by the relevant future gate if proposed.

## Product-language guardrails
Allowed:
- `Buildability-aware concept`.
- `Concept Layout Plan`.
- `Concept-stage visual`.
- `Dimensionally consistent with the accepted spatial model` where validated.
- `Editable CAD handoff` / `Editable 3D handoff` where the relevant import/edit validation passed.

Do not claim:
- `Construction-ready`.
- `Fabrication-ready`.
- `Engineer-approved`.
- `Venue-approved`.
- `Structurally certified`.

## MVP acceptance scenario
Using representative exhibition-booth briefs, a user can complete:

`dimensions/open sides -> brief/reference intake -> confirmed requirements -> four concepts -> QA/repair -> selection/refinement/edit -> final hero -> Concept Layout Plan/PDF -> accepted spatial model -> coherent views -> editable 2D CAD -> editable 3D -> 3ds Max-compatible handoff -> complete design package`

without needing to write specialist image-generation prompts and without material geometry silently changing between downstream outputs.

## Success question
The full-suite MVP succeeds if exhibition professionals can answer yes to both:
- `Would I use this to prepare tomorrow's client proposal?`
- `Could my design team continue this accepted design in normal CAD/3D production tooling without rebuilding a different booth from scratch?`
