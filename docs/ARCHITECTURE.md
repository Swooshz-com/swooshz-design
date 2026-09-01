# Full-Suite MVP Architecture

## Architecture principle
Build one coherent design system around a single accepted spatial source of truth. Preserve the existing simple web application and accepted S1-S5 boundaries; add CAD/3D/tooling infrastructure only where a later accepted gate proves it is necessary for the full-suite MVP.

The MVP is not a collection of independent AI interpretations. Concept imagery, coherent views, CAD and 3D must remain bound to durable project/revision truth.

## Current programme architecture
S1-S5 are terminal upstream foundations for:
- Project/brief confirmation.
- Four concept generations.
- Visual QA and bounded repair.
- Immutable selection/refinement/local-edit revisions.
- Final visual approval/frozen context.
- Concept Layout Plan.
- Client presentation PDF.
- Private artifact publication/recovery.
- Privacy-safe durable-source telemetry.

S6-S9 extend the overall MVP into:
- One canonical spatial-design model.
- Coherent additional camera views.
- Editable 2D CAD.
- Editable 3D and 3ds Max-compatible handoff.
- Full-suite integration/UAT/finality.

Historical S1-S5 exclusions remain valid for those slices; they no longer define the overall programme completion boundary.

## Core stack
- Web application: Next.js + React + TypeScript.
- Server/API: Next.js server-side routes/actions unless a concrete accepted integration requires a separate worker/service.
- Database: PostgreSQL or an accepted equivalent durable relational store.
- Object storage: private S3-compatible storage or accepted equivalent for source and generated assets.
- Background work: minimum-sufficient durable job abstraction for operations that exceed request lifetimes.
- PDF generation: deterministic server-owned renderer already established by S5.
- AI provider interfaces: narrow provider boundaries; no multi-provider marketplace/routing requirement.
- Spatial/CAD/3D tooling: selected only through the relevant S6-S8 G1/G2 gates.

Do not introduce microservices, Autodesk services, desktop automation or native proprietary format dependencies merely because they are available. Each must justify its trust, licensing, privacy, cost, reliability and deployment boundary.

## Source-of-truth hierarchy
The durable source of truth is structured project/revision data, not generated image pixels alone.

When geometric/design facts conflict, authority is:
1. User-confirmed hard project facts such as booth dimensions and open sides.
2. User-confirmed structured requirements and exact counts.
3. The accepted immutable canonical spatial-model revision.
4. Downstream CAD/3D/render artifacts derived from that exact revision.
5. Approved hero/reference imagery for appearance/design intent.
6. Bounded AI inference only where represented as an assumption/design decision.

No generated image may silently override confirmed dimensions, open sides, counts or accepted spatial geometry.

## Existing upstream project/revision truth

### Project
Stores durable project identity and confirmed booth facts, including:
- Project identity/name.
- Booth dimensions/open-side orientation.
- Optional maximum height/budget/venue context.
- Confirmed brief/revision references.
- Source asset references.
- Selected/final-approved visual lineage.

### Brief and concept revisions
Brief and image revisions are immutable. Generated/edited revisions retain their source brief, parent lineage, operation, compiler/provider identity, QA evidence and durable timing/cost metadata where available.

Never overwrite accepted image assets/revisions in place.

### Final S5 approval and outputs
S5 freezes one exact eligible visual source and confirmed context, then derives its Concept Layout Plan, client PDF and telemetry from that frozen truth.

The S5 Concept Layout Plan is concept-stage planning evidence only. It does not become fabrication CAD or the geometric source of truth for S6-S8.

## Canonical spatial-design model
S6 creates the new downstream geometric source of truth.

The accepted versioned schema must be sufficient, subject to S6 G1/G2, to represent at minimum:
- Millimetre project units.
- Stable world coordinate convention.
- Exact confirmed booth footprint/open sides.
- Known maximum height where confirmed.
- Modeled walls/partitions and major architectural volumes.
- Modeled overhead volumes/support intent.
- Named functional zones.
- Major modeled furniture/displays/counters/screens/equipment.
- Stable object IDs and semantic roles.
- Parent/child object hierarchy.
- Position, rotation, scale and asserted dimensions.
- Material/finish/brand references where known.
- Provenance for material geometry.
- Explicit unknown/assumption state.
- Immutable revision lineage and acceptance state.

A material spatial edit creates a new immutable model revision. Accepted history is never rewritten in place.

Every downstream view/CAD/3D artifact binds to one exact spatial revision. When that spatial revision is superseded, prior downstream artifacts become stale and must not present themselves as current.

## Geometry provenance / false precision
Every material modeled fact must be representable as one of these semantic states, even if exact persisted names differ:
- Confirmed project input.
- User-confirmed design decision.
- Bounded design inference.
- Unknown/unresolved.

Unknown geometry is never silently promoted to confirmed precision simply to satisfy an exporter.

An inferred design choice may become normal accepted design geometry after the user accepts the spatial revision, but it remains distinguishable from an original client-supplied fact where provenance matters.

## S6 model creation and review
S6 consumes terminal S5 truth read-only. It may use deterministic/parametric geometry, bounded AI-assisted reconstruction or a hybrid, subject to G1/G2.

Preferred minimum-sufficient posture:
- Use simple validated booth primitives/parametric object families where they improve dimensional reliability.
- Validate the model independently against confirmed geometry/open sides/counts before acceptance.
- Surface unresolved assumptions rather than inventing hidden geometry.

Before S7 CAD export, the user must have a bounded way to correct material spatial errors or explicitly accept the model revision.

The MVP does not require a complete browser CAD editor. The chosen correction interaction should be the smallest usable mechanism: for example object/property editing, move/resize/rotate controls, structured zone editing or another G1/G2-proven flow.

Corrections create new spatial revisions.

## Coherent additional views
Additional views are derived from or strongly conditioned by the same accepted spatial model.

A valid coherent-view pipeline preserves:
- Booth footprint/open sides.
- Major walls/partitions/volumes.
- Major object identity/placement.
- Relative dimensions/scale within explicit tolerance.
- Material overhead architecture/support intent.

Preferred architecture:
`accepted spatial model -> geometry-backed render -> optional bounded appearance enhancement -> preservation/consistency check`

Independent free-form generations that merely imitate the hero are not accepted as final geometric multi-angle truth.

If a visual enhancement stage materially changes geometry, the output fails/flags rather than silently replacing the design.

## Editable 2D CAD architecture
S7 derives 2D CAD from one accepted spatial revision.

Required output semantics include:
- Millimetre units.
- Booth boundary/dimensions/open sides.
- Modeled walls/partitions.
- Named zones.
- Major modeled furniture/equipment/display footprints.
- Useful layers/object semantics and dimensions/labels.
- Exact source-revision identity outside client-visible geometry where suitable.

DXF is the interoperability baseline unless S7 G1/G2 proves a better open/testable editable minimum-sufficient format.

Native DWG is optional. It may be added only with a licensed, reliable and testable generation/conversion path. Never fake a proprietary format by renaming another file.

S7 validation must prove representative export/import preserves units, booth dimensions, open sides, major geometry and editability within explicit tolerance.

S7 output is design CAD, not fabrication/shop drawings.

## Editable 3D / 3ds Max handoff architecture
S8 derives editable 3D from the same accepted spatial revision used by S7.

The handoff must preserve useful:
- World units and coordinate convention.
- Major geometry/dimensions.
- Object identity/hierarchy/names.
- Object transforms.
- Material references/assignments where supported.
- Cameras/views where useful.

The MVP requirement is a production-useful file that imports into 3ds Max with editable geometry and preserved major dimensions/hierarchy.

Native `.max` is not mandatory unless S8 G1/G2 proves a licensed, deterministic and supportable automation path. FBX or another proven editable Max-compatible format may satisfy the accepted contract.

Validation must prove import consistency and explicitly report unsupported/degraded materials or other semantics. No material geometry may silently disappear or be invented.

## Autodesk APS policy
Autodesk APS is optional infrastructure, not an MVP outcome and not automatically required for AutoCAD/3ds Max interoperability.

Use APS only when the relevant gate demonstrates it materially simplifies a required capability such as viewing, translation or validation and that its licence, privacy, cost, availability and data-handling boundaries are acceptable.

## Cross-output consistency contract
For one accepted spatial revision, these surfaces must materially agree:
- Coherent additional views.
- Editable 2D CAD.
- Editable 3D.
- 3ds Max-compatible handoff.

At minimum compare under explicit G2 tolerances:
- Outer booth dimensions.
- Open-side orientation.
- Major wall/partition positions.
- Major object count/identity.
- Major object placements.
- Overhead architecture where modeled.
- Named functional-zone relationships.

Consistency is tested using structured geometry where possible rather than visual judgement alone.

## Artifact lifecycle
S6-S8 follow the integrity posture established upstream:
- Immutable accepted source revisions.
- Private storage by default.
- Exact source-revision binding.
- Authorization before disclosure/download.
- Integrity/hash checks where appropriate.
- No-overwrite/idempotent publication.
- Recoverable publication/restart behavior.
- Stale-output fencing after source revision changes.
- Generic safe public errors.
- Privacy-minimised logs.

A downstream artifact is current only when its exact source spatial revision is still accepted/current and required integrity checks pass.

## Security/privacy
- Provider/tool credentials remain server-side and outside repository content.
- Secret names may be documented; values never are.
- Uploaded/customer assets remain private by default.
- Validate file types/sizes and generated output boundaries.
- Avoid logging customer source content or generated payloads unnecessarily.
- External provider/Autodesk/desktop-tool use remains separately gated when it changes trust, cost or deployment boundaries.

## Failure posture
Fail/flag rather than fake success when:
- Spatial geometry contradicts confirmed dimensions/open sides.
- Required geometry remains unresolved without an assumption.
- A coherent view materially drifts from the accepted spatial model.
- CAD export/import changes units or material geometry.
- 3D/Max handoff loses material objects/dimensions/hierarchy.
- A downstream artifact is stale.
- Required external conversion/tooling is unavailable.
- Authorization/integrity validation fails.

No fallback may silently substitute a different geometry source.

## Programme decomposition
- S1-S5: accepted upstream concept/revision/approval/presentation foundation.
- S6 #11: canonical spatial-design model + coherent multi-angle views.
- S7 #28: accurate editable 2D CAD handoff.
- S8 #29: editable 3D + 3ds Max-compatible handoff.
- S9 #30: full-suite integration/UAT/final alpha assurance.

Each child uses G1/G2/G3/G4 internally. Later children do not rewrite the historical authority of earlier accepted slices.

## S6 G1 entry criteria
S6 G1 begins only after:
- Terminal S5 merge/canonical verification.
- User/Web approval of the full-suite written architecture.
- Canonical PRD/MVP scope/architecture reconciliation.
- Parent/child transition reconciliation.

G1 must resolve, at minimum:
- Exact S5-to-S6 read-only source projection and stale/finality requirements.
- Canonical spatial schema and world coordinate/units convention.
- Geometry provenance/assumption semantics.
- Model-creation approach and validation boundary.
- Smallest usable user correction/acceptance interaction.
- Coherent-view generation/preservation architecture.
- Spatial revision/artifact lifecycle and stale fencing.
- Security/privacy/tool/provider trust boundaries.
- Required test/evidence obligations.
- Explicit handoff requirements to S7 without implementing S7 CAD in S6.

## S6 G1 must not add
Without separate later authority:
- S7 CAD implementation.
- S8 3D/Max production implementation.
- Structural engineering/certification.
- Fabrication/shop drawings.
- Costing/BOM/quotation.
- Venue-rule automation.
- Billing/CRM/enterprise/multi-provider scope.

## ELI5
The first five slices got us from brief to an approved concept, concept plan and client PDF. The full-suite MVP now adds one trustworthy digital booth model. Extra views, CAD and 3D all come from that same accepted model, so changing the camera or export format does not secretly create a different booth. The system helps designers continue the design; it does not pretend to replace structural engineers or fabricators.
