# Full-Suite MVP Scope Lock

## Goal
Prove that an exhibition professional can turn a confirmed booth brief into a coherent, editable design package spanning concept visuals, one accepted spatial design, matching views, editable CAD and editable 3D handoff.

## Programme status
S1-S5 are accepted upstream foundations. Their historical slice boundaries remain valid. The current programme-level MVP now extends beyond the earlier concept/PDF boundary into S6-S9.

## In scope

### Project intake
- Create project.
- Mandatory booth width and depth.
- Mandatory open-side selection/orientation.
- Optional maximum height and budget.
- PDF/image/logo/reference upload.

### Brief interpretation
- Extract structured requirements from supplied materials.
- Surface unknown/ambiguous critical fields for user confirmation.
- Let the user edit the extracted brief before generation.
- Preserve immutable brief/revision lineage.

### Concept generation
- Internal booth-specific prompt compiler/library.
- Exactly four initial concept candidates per set.
- One integrated image-generation provider is sufficient for the accepted concept-stage MVP path.
- Distinct concept directions while preserving hard project requirements.

### QA and bounded repair
- Visual requirement/buildability QA against accepted design rules.
- Material failures visible to the user.
- At most one automatic repair attempt per failed concept candidate in the accepted path.
- No repeated autonomous repair loops.

### Selection and revision
- Select one concept.
- Immutable revision graph/history.
- Bounded user-requested enhancement/refinement revisions.
- Rectangle/brush local edit mask + user instruction.
- Protected-region comparison after local edit.
- Explicit final hero approval/reopen history.

### S5 concept outputs
- Final hero image.
- Concept Layout Plan.
- Client presentation PDF.
- Private downloadable image/PDF assets.
- Privacy-safe durable-source telemetry.

These remain concept-stage outputs. The Concept Layout Plan is not fabrication CAD and is not the S6-S8 geometric source of truth.

### S6 canonical spatial design
- Create one immutable, versioned canonical spatial-design model from confirmed project facts plus approved design intent.
- Millimetre units and stable world coordinates.
- Exact confirmed booth footprint/open sides.
- Modeled walls, partitions, major architectural volumes and major equipment/furniture where represented.
- Stable object identity, hierarchy, transforms and asserted dimensions.
- Geometry provenance distinguishing confirmed facts, user-confirmed design decisions, bounded design inference and unknowns.
- User review/correction or explicit acceptance before CAD handoff.
- Immutable spatial revisions; no in-place overwrite of accepted geometry.

### S6 coherent additional views
- Produce additional camera views from or strongly conditioned by the accepted spatial model.
- Preserve material geometry and major-object placement across views.
- Geometry-backed rendering is preferred; bounded appearance enhancement is permitted only with preservation assurance.
- Independent free-form image prompts are not accepted as final geometric multi-angle truth.

### S7 editable 2D CAD handoff
- Derive an editable plan from one accepted spatial-model revision.
- Millimetre units, booth boundary/dimensions and open-side geometry.
- Modeled walls/partitions, zones and major object footprints.
- Useful layer/object semantics and dimensions/labels.
- DXF as the mandatory interoperability baseline unless G1/G2 accepts another open/testable editable minimum-sufficient format.
- Native DWG only when a licensed, reliable and testable path is accepted.
- Export/import validation against the canonical spatial model.

### S8 editable 3D and 3ds Max-compatible handoff
- Derive editable 3D from the same accepted spatial-model revision.
- Preserve useful world scale, geometry, transforms, hierarchy/object identity and supported materials.
- Provide a production-useful handoff importable into 3ds Max with editable geometry and preserved major dimensions/hierarchy.
- Native `.max` is optional; FBX or another proven editable 3ds Max-compatible format may satisfy the MVP.
- Validate import consistency and truthfully report unsupported/degraded material data.

### S9 integration/UAT
- Prove one coherent design remains materially consistent from brief through concept, spatial model, views, CAD and 3D.
- Verify stale downstream artifacts cannot masquerade as current after a spatial revision changes.
- Verify failure/retry/recovery and privacy/security boundaries.
- Run representative real-project-style UAT under current data/operational authority.

### Artifact integrity and privacy
- Private storage by default.
- Immutable source revision binding.
- Authorization before disclosure/download.
- Integrity/hash checks where appropriate.
- Idempotent/recoverable publication.
- Stale-output fencing.
- Privacy-minimised logs.
- Secret names only where documentation requires them; never secret values.

### Telemetry
Record durable-source evidence where available for:
- Generation/edit latency.
- Provider cost only when durably exposed.
- QA/repair outcomes.
- Revision/refinement/edit counts.
- Time to accepted concept/final hero.
- Spatial-model corrections/acceptance.
- Coherent-view consistency failures.
- CAD export/import success and dimensional consistency.
- 3D/3ds Max handoff success/failure/degradation.
- End-to-end time to completed package.

Missing/corrupt sources must remain unavailable rather than being silently zero-filled or reconstructed.

## Explicitly out of scope
Unless User/Web explicitly expands the programme later:
- Structural engineering calculations/certification.
- Fabrication/shop drawings or construction sign-off.
- Venue compliance database or automated venue approval.
- Costing/quotation/BOM.
- Supplier catalogue.
- CRM/project-management suite.
- White-label/enterprise customisation/permissions.
- Billing/subscriptions.
- Multi-provider model marketplace or automatic provider routing.
- Fine-tuning/training custom image models as an MVP requirement.

Autodesk APS is not inherently in scope. It is optional infrastructure that may be selected only when a later G1/G2 proves it is the minimum-sufficient path for an accepted capability.

## Product language guardrails
Use where accurate and validated:
- `Buildability-aware concept`.
- `Concept Layout Plan`.
- `Concept-stage visual`.
- `Dimensionally consistent with the accepted spatial model`.
- `Editable CAD handoff`.
- `Editable 3D / 3ds Max-compatible handoff`.

Do not claim:
- `Construction-ready`.
- `Fabrication-ready`.
- `Engineer-approved`.
- `Venue-approved`.
- `Structurally certified`.

## Cross-output truth rule
All downstream geometric outputs must derive from one accepted canonical spatial-model revision.

The approved hero/reference images provide visual/design intent. They are not geometric authority and may not silently override confirmed project facts or accepted spatial geometry.

For one accepted spatial revision, coherent views, CAD and editable 3D must agree on material geometry within explicit tolerances defined by the owning G2 contract.

## Acceptance flow
A user must be able to complete this sequence end-to-end:
1. Enter booth dimensions/open sides.
2. Upload brief/reference material.
3. Review/edit extracted requirements.
4. Generate four concept candidates.
5. See QA outcomes and bounded repair result where applicable.
6. Select a concept.
7. Perform targeted refinement/local edit where desired.
8. Lock a final hero revision.
9. Generate the Concept Layout Plan and presentation PDF.
10. Create/review/accept one canonical spatial-model revision.
11. Produce coherent additional views from that revision.
12. Generate/import an editable 2D CAD handoff from that revision.
13. Generate/import editable 3D and a 3ds Max-compatible handoff from that revision.
14. Download the complete design package.
15. Pass cross-output consistency and final full-suite UAT.

## Acceptance quality
- Hard input requirements remain attached to every relevant revision.
- No silent overwrite of approved/generated images or accepted spatial revisions.
- Concept QA is useful without being described as engineering validation.
- Local editing does not silently accept major protected-region drift.
- Unknown geometry is not converted into fake confirmed precision.
- Material geometry remains consistent across accepted coherent views, CAD and 3D.
- CAD/3D outputs are genuinely editable, not flattened pictures presented as editable files.
- Import validation proves units/dimensions/major geometry survive the handoff.
- Stale downstream files cannot present themselves as current.
- The product clearly distinguishes design-production outputs from engineering/fabrication certification.

## Programme slices
- S1-S5: terminal upstream concept/revision/approval/presentation foundation.
- S6 #11: canonical spatial design + coherent multi-angle views.
- S7 #28: accurate editable 2D CAD handoff.
- S8 #29: editable 3D + 3ds Max-compatible handoff.
- S9 #30: full-suite integration/UAT/final alpha assurance.
