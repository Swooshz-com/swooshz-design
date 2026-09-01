# Swooshz Design Full-Suite MVP Architecture Decision

Date: 2026-09-01
Status: **APPROVED BY USER/WEB — CANONICAL DOCS RECONCILED ON PR #33**
Programme parent: #1
Slices: S6 #11, S7 #28, S8 #29, S9 #30

## Decision

The Swooshz Design MVP is the full exhibition-design suite, not only a concept-generation/presentation tool.

Accepted end-to-end boundary:

`brief -> structured requirements -> four concepts -> QA/repair -> selection/refinement -> masked local edit -> final hero -> Concept Layout Plan/client presentation -> canonical spatial design model -> coherent additional views -> editable 2D CAD -> editable 3D -> 3ds Max-compatible handoff -> complete downloadable design package -> full-suite UAT/finality`

S1-S5 remain valid accepted upstream foundations. Their historical exclusions are not rewritten; the programme-level MVP now continues beyond them through S6-S9.

## Core rule: one canonical spatial truth

All downstream geometric outputs derive from one accepted immutable canonical spatial-model revision.

```text
confirmed project facts + approved S5 design intent
                    |
                    v
         canonical spatial-design model
          /          |           \
         /           |            \
coherent views   editable CAD   editable 3D
                                  |
                                  v
                      3ds Max-compatible handoff
```

The approved hero/reference images are visual/style/design-intent evidence. They are **not** geometric authority and must never silently override confirmed dimensions, open sides, exact counts or accepted spatial geometry.

## Authority hierarchy

Unless a later accepted gate deliberately narrows it, conflicting facts resolve in this order:

1. User-confirmed hard project facts.
2. User-confirmed structured requirements/counts.
3. Accepted canonical spatial-model revision.
4. Derived CAD/3D/view artifacts bound to that revision.
5. Approved hero/reference imagery for appearance/design intent.
6. Bounded AI design inference only where represented as an assumption/design decision.

Unknown geometry remains explicit. The system must not invent fake confirmed precision simply because an exporter needs coordinates.

## Canonical spatial-model requirements

S6 G1/G2 must define an immutable versioned schema sufficient for S6-S8, including at minimum:
- Millimetre units and stable world coordinates.
- Exact confirmed booth footprint/open sides.
- Confirmed maximum height where available.
- Modeled walls/partitions and major architectural/overhead volumes.
- Named functional zones.
- Major modeled furniture, displays, counters, screens and equipment.
- Stable object identity and semantic role.
- Parent/child hierarchy.
- Position, rotation, scale and asserted dimensions.
- Material/finish/brand references where known.
- Geometry provenance.
- Explicit assumption/unknown state.
- Immutable revision lineage and acceptance state.

Material spatial corrections create a new revision rather than rewriting accepted history.

Every downstream artifact records its exact source spatial revision. Superseding that revision makes earlier downstream artifacts stale; stale artifacts cannot present themselves as current.

## Geometry provenance

Every material modeled fact must remain semantically distinguishable as:
- confirmed project input;
- user-confirmed design decision;
- bounded design inference; or
- unknown/unresolved.

An inferred design choice may become normal accepted design geometry after the user accepts the spatial revision, but it must not be misrepresented as an original client-supplied fact.

## S6 — canonical spatial model + coherent views

S6 consumes terminal S5 truth read-only:
- approved visual/frozen context;
- confirmed booth geometry/open sides;
- confirmed structured requirements/counts;
- S5 Concept Layout Plan as concept-stage planning evidence;
- hero/reference assets as visual intent.

S6 must not rewrite S5 history.

The model-creation architecture may be deterministic/parametric, bounded AI-assisted or hybrid, but admitted geometry must be independently validated against confirmed facts before acceptance.

Prefer simple validated booth primitives/parametric object families where they improve dimensional reliability over uncontrolled mesh generation.

Before S7 export, the user must be able to review/correct material spatial errors or explicitly accept the spatial revision. The MVP does not require a full browser CAD editor; use the smallest usable correction interaction proven by S6 G1/G2.

### Coherent additional views

Additional views must derive from or be strongly conditioned by the same accepted spatial geometry.

They must preserve within defined tolerance:
- booth footprint/open sides;
- material walls/partitions/volumes;
- major object identity/placement;
- relative dimensions/scale;
- material overhead architecture/support intent.

Preferred pipeline:

`accepted spatial model -> geometry-backed render -> optional bounded appearance enhancement -> geometry-preservation/consistency check`

Independent free-form image prompts that merely imitate the hero are not accepted as final multi-angle geometric truth.

## S7 — editable 2D CAD handoff

S7 derives CAD from one accepted spatial revision.

Minimum content:
- millimetre units;
- booth boundary/dimensions/open sides;
- modeled walls/partitions;
- named zones;
- major modeled object footprints;
- useful layer/object semantics;
- useful dimensions/labels.

### Format policy

DXF is the mandatory interoperability baseline unless S7 G1/G2 proves another equally open/testable/editable format is a better minimum-sufficient choice.

Native DWG is desirable but not mandatory. It may be added only through a licensed, reliable and testable generation/conversion path. Never fake DWG by renaming another format.

### Validation

Representative export/import must prove:
- units survive;
- booth dimensions/open sides survive;
- major geometry matches the canonical model within defined tolerance;
- entities/layers remain editable rather than flattened;
- the file opens/imports successfully in representative AutoCAD-compatible tooling.

S7 output is design CAD, not fabrication/shop drawings.

## S8 — editable 3D + 3ds Max-compatible handoff

S8 derives editable 3D from the same accepted spatial revision used by S7.

The scene/handoff must preserve useful:
- world units/coordinate convention;
- major geometry/dimensions;
- object identity/hierarchy/names;
- transforms;
- material references/assignments where supported;
- cameras/views where useful.

The MVP requires a production-useful handoff importable into 3ds Max with editable geometry and preserved major dimensions/hierarchy.

Native `.max` is **not mandatory** unless S8 G1/G2 proves a licensed, deterministic and supportable automation path. FBX or another proven editable 3ds Max-compatible format may satisfy the MVP.

Import validation must report unsupported/degraded material semantics truthfully and must not silently add/drop material geometry.

## Autodesk APS policy

Autodesk APS is optional infrastructure, not an MVP outcome and not automatically required because AutoCAD/3ds Max are downstream tools.

Use APS only when the relevant G1/G2 proves it materially simplifies a required viewing/translation/validation capability and its licence, privacy, cost, availability and data-handling boundaries are acceptable.

## Cross-output consistency contract

For one accepted spatial revision, coherent views, editable CAD, editable 3D and the 3ds Max-compatible handoff must materially agree.

At minimum compare under explicit G2 tolerances:
- outer booth dimensions;
- open-side orientation;
- major walls/partitions;
- major object identity/count/placement;
- overhead architecture where modeled;
- named functional-zone relationships.

Use structured geometry checks where possible rather than visual judgement alone.

## Artifact/integrity lifecycle

S6-S8 preserve the upstream integrity posture:
- immutable accepted source revisions;
- private storage by default;
- exact source-revision binding;
- authorization before disclosure/download;
- integrity checks where suitable;
- no-overwrite/idempotent publication;
- recoverable publication/restart behavior;
- stale-output fencing;
- generic safe public errors;
- privacy-minimised logs.

No fallback may silently substitute a different geometry source or claim successful handoff when validation failed.

## Product boundary / exclusions

Still outside MVP unless User/Web separately expands it:
- structural engineering calculations/certification;
- fabrication/shop drawings/construction sign-off;
- venue approval/rule automation;
- costing/BOM/quotation;
- supplier catalogue;
- billing/subscriptions;
- CRM/project-management suite;
- white-label/enterprise permissions;
- multi-provider marketplace/routing.

The product may claim dimensional consistency with the accepted spatial model only when validated. It must not claim engineer-approved, fabrication-ready, venue-approved or structurally certified output.

## Programme decomposition

### S6 #11
Canonical spatial-design model + coherent multi-angle views.

Question: `What is the one accepted spatial design, and can every accepted camera view describe that same booth?`

### S7 #28
Accurate editable 2D CAD handoff.

Question: `Can an AutoCAD-compatible tool open an editable plan that reflects the accepted spatial design?`

### S8 #29
Editable 3D + 3ds Max-compatible production handoff.

Question: `Can a 3D designer continue the same design in a real 3ds Max workflow without rebuilding a different booth?`

### S9 #30
Full-suite integration, representative real-project UAT + final alpha assurance.

Question: `Does one booth remain the same design from brief through concept, views, CAD and 3D, with truthful privacy/recovery/failure behavior?`

## Canonical-doc reconciliation

Following User/Web written-spec approval, PR #33 reconciles the current programme definition into:
- `docs/PRD.md`;
- `docs/MVP_SCOPE.md`;
- `docs/ARCHITECTURE.md`.

These programme-level docs now extend the MVP through S6-S9 while preserving S1-S5 as historical accepted upstream slice boundaries.

## Sequencing

Satisfied before S6 G1:
- S5 terminal accepted/merged/canonical.
- Full-suite written architecture approved by User/Web.
- Canonical PRD/MVP scope/architecture reconciled through docs PR #33.

Still required before S6 implementation:
1. Docs PR #33 reaches terminal Web merge/canonical verification.
2. S6 receives fresh G1 architecture/authority acceptance.
3. S6 receives G2 implementation-contract acceptance.

S7 cannot begin before terminal S6. S8 cannot begin before terminal S7. S9 cannot become terminal before S1-S8 are complete.

## ELI5

S1-S5 got us from brief to an approved concept, concept plan and client PDF. The full-suite MVP now adds one trustworthy digital booth model. Extra views, CAD and 3D all come from that same accepted model, so a new camera angle or export format cannot silently turn it into a different booth. Designers can continue the design in normal CAD/3D tooling, while engineering/fabrication certification stays outside the MVP.
