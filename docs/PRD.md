# Swooshz Design MVP PRD

## Product
AI Exhibition Design Copilot for exhibition contractors and design houses.

## Problem
Normal users receive booth briefs but often lack the prompt-writing skill and time needed to turn them into strong visual concepts quickly. Generic image models also produce recurring exhibition-design defects such as unsupported overhead structures, incorrect functional counts, objects outside the footprint, implausible scale and destructive small edits.

## MVP promise
Upload a booth brief and receive strong, buildability-aware concept visuals and a client-ready concept presentation without learning AI prompting.

## Target user
Primary: Sales/design staff at exhibition contractors and design houses who need a credible first concept quickly.

## Primary journey
1. Create project.
2. Enter mandatory booth width and depth.
3. Select open sides (1–4). The UI must make the location/orientation of the open sides explicit.
4. Optionally enter maximum height and budget.
5. Upload brief PDF, reference images and logo/brand assets.
6. System extracts an editable structured brief.
7. User confirms/corrects extracted requirements.
8. System compiles booth-specific prompts and generates four concept candidates.
9. System reviews candidates against the structured brief and design/buildability rules.
10. Candidates with a material failure may receive at most one automatic repair attempt.
11. User selects a concept.
12. User may run 1–2 targeted enhancement/refinement revisions.
13. User may draw/brush a local edit region and provide an edit instruction.
14. The system preserves the rest of the image as far as the provider permits and rejects edits that materially alter protected regions.
15. User locks a final hero revision.
16. System generates a clearly labelled Concept Layout Plan from the locked brief + hero + booth dimensions.
17. System generates a basic presentation PDF containing the project summary, final hero, concept layout plan and design notes.
18. User downloads the outputs.

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

## Concept generation
- Generate four distinct design directions per generation set.
- Every candidate receives the same confirmed structured brief and booth-rule package.
- Prompt implementation is internal; users should not need to author specialist prompts.
- Provider integration must be replaceable behind a small interface, but v0.1 integrates only one image provider.

## Visual QA
The system checks at minimum:
- Required functional zones/counts are visibly represented where reasonably observable.
- Objects do not obviously extend outside the booth footprint.
- Overhead architectural elements have plausible visible support or are explicitly treated as rigged.
- Screens/large fixtures have plausible support.
- Furniture/equipment scale is credible.
- Main entrances/open sides are not obviously blocked.
- Branding/style constraints are materially followed.
- Prohibited IP/branding requirements are respected.

QA is concept-level visual screening, not engineering certification.

## Local editing
MVP interaction: User-drawn rectangle/brush mask + edit instruction.

Requirements:
- Preserve the selected source revision immutably.
- Create a new child revision for every edit.
- Apply the user mask to the image edit provider when supported.
- Compare protected/non-mask regions before accepting the result.
- Reject/flag an edit if protected regions change materially.
- Allow undo by selecting any prior revision.

## Revision model
Every generated or edited image is immutable and linked to:
- Project.
- Parent revision (if any).
- Generation/edit operation.
- Structured brief version.
- Prompt/compiler version.
- Provider/model identifier (non-secret metadata only).
- QA result.
- Cost/latency telemetry where available.

## Concept Layout Plan
The output must be labelled `Concept Layout Plan` and must not be represented as construction/fabrication CAD.

It should show:
- Booth boundary and dimensions.
- Open-side orientation.
- Named functional zones.
- Approximate furniture/equipment placement.
- Main circulation intent.

## Presentation PDF
Minimum content:
- Project title and key booth facts.
- Final hero visual.
- Concept Layout Plan.
- Short design concept summary.
- Explicit note that the plan/visuals are concept-stage outputs and require contractor/engineer/venue validation before fabrication.

## MVP non-goals
- 3D generation or interactive 3D.
- Autodesk APS / 3ds Max.
- Native `.max` export.
- Geometrically exact multiple camera angles.
- Construction drawings.
- Structural calculations or certification.
- Venue-rule database.
- Costing/quotation.
- Billing.
- CRM.
- White-label/enterprise workflows.

## MVP acceptance scenario
Using a real brief similar in complexity to a 6 m × 6 m raw-space exhibition booth, a user can complete:

`dimensions → brief extraction → 4 concepts → QA → select → targeted edit/refine → final hero → Concept Layout Plan → PDF`

without needing to write a specialist image-generation prompt.

## Product telemetry
Record enough data to evaluate viability:
- Generation latency.
- Provider cost where exposed.
- Concept acceptance/rejection.
- QA failure categories.
- Automatic repair usage/result.
- Number of revisions.
- Local edit success/failure.
- Time from project creation to locked hero.
- Total AI cost per completed project.

## Success question
The MVP succeeds if exhibition professionals can answer yes to: `Would I use this to prepare tomorrow's client proposal?`
