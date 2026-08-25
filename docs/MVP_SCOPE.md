# MVP Scope Lock

## Goal
Prove that a non-expert user can turn an exhibition-booth brief into useful, buildability-aware concept visuals and a client-ready concept presentation quickly.

## In scope
### Project intake
- Create project.
- Mandatory booth width and depth.
- Mandatory open-side selection/orientation.
- Optional maximum height and budget.
- PDF/image/logo upload.

### Brief interpretation
- Extract structured requirements from supplied materials.
- Surface unknown/ambiguous critical fields for user confirmation.
- Let the user edit the extracted brief before generation.

### Concept generation
- Internal booth-specific prompt compiler/library.
- Exactly four initial concept candidates per set.
- One integrated image-generation provider for v0.1.
- Distinct concept directions while preserving hard project requirements.

### QA and repair
- Visual requirement/buildability QA against `DESIGN_RULES.md`.
- Material failures are visible to the user.
- At most one automatic repair attempt per failed candidate.
- No repeated autonomous repair loops.

### Selection and revision
- Select one concept.
- Immutable revision graph/history.
- 1–2 user-requested enhancement/refinement iterations.
- Rectangle/brush local edit mask + user instruction.
- Protected-region comparison after local edit.

### Final outputs
- Final hero image.
- Concept Layout Plan.
- Basic client presentation PDF.
- Downloadable image/PDF assets.

### Telemetry
- Provider/model identifier without secret values.
- Generation/edit latency.
- AI cost where available.
- QA outcome/failure category.
- Repair count/result.
- Revision count.
- Local-edit success/failure.
- Time to locked hero.

## Explicitly out of scope
- 3D model generation.
- Autodesk APS integration.
- 3ds Max scene generation.
- `.max` export.
- Autodesk Viewer.
- Geometrically exact multi-angle renders.
- Native CAD/BIM output.
- Construction/fabrication drawings.
- Structural engineering calculations/certification.
- Venue compliance database or automated venue approval.
- Costing/quotation/BOM.
- Supplier catalogue.
- CRM/project management.
- White-label/enterprise customisation.
- Billing/subscriptions.
- Multi-provider model marketplace or automatic provider routing.
- Fine-tuning/training custom image models.

## Product language guardrails
Use:
- `Buildability-aware concept`.
- `Concept Layout Plan`.
- `Concept-stage visual`.

Do not claim:
- `Buildable` as an engineering guarantee.
- `Construction-ready`.
- `Fabrication-ready`.
- `Engineer-approved`.
- `Venue-approved`.

## Two-week protection rule
Any feature not necessary to complete the acceptance flow below is deferred unless the owner explicitly changes the MVP scope.

## Acceptance flow
A user must be able to complete this sequence end-to-end:

1. Enter booth dimensions/open sides.
2. Upload a brief/reference material.
3. Review/edit extracted requirements.
4. Generate four concept candidates.
5. See QA outcomes and any single repair result.
6. Select a concept.
7. Perform at least one targeted refinement or masked local edit.
8. Lock a final hero revision.
9. Generate a Concept Layout Plan.
10. Generate/download a presentation PDF.

## Acceptance quality
- Hard input requirements remain attached to every revision.
- No silent overwrite of approved/generated images.
- Obvious visual buildability failures are detected often enough to be useful and never described as engineering validation.
- Local editing does not silently accept major changes outside the requested region.
- The output clearly distinguishes concept work from construction documentation.

## Deferred next phase
Only after MVP evidence supports it:

`floor-plan editor → structured 3D reconstruction → 3ds Max Automation → actual multi-angle renders → Autodesk Viewer → .max export`
