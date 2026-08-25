# Booth Design Rules — MVP

## Purpose
These rules guide prompt compilation and visual QA. They improve concept realism but do not replace contractor, engineer, organiser or venue review.

## Hard project constraints
- Respect the confirmed booth width and depth.
- Respect the confirmed number and orientation of open sides.
- Respect maximum height when supplied.
- Preserve exact functional counts when specified (for example: four demo stations means four visible/allocated stations).
- Preserve explicit client prohibitions, brand constraints and IP restrictions.
- Do not silently invent critical missing venue/engineering facts.

## Footprint and circulation
- Keep booth fixtures/equipment visually within the booth boundary.
- Do not place furniture, simulators, counters or displays partly into the aisle unless the brief explicitly allows an external activation area.
- Keep open sides visibly accessible.
- Avoid obvious circulation dead-ends or furniture blocking primary access.
- Maintain plausible human clearance around seating, counters, demo stations and interactive equipment.

## Structural plausibility
- No unexplained floating architectural elements.
- Large overhead fascia/canopies must show plausible support or be explicitly represented as suspended/rigged.
- Avoid extreme unsupported cantilevers unless the design explicitly communicates an engineered structure.
- Structural columns/supports should connect logically from load-bearing overhead elements to the floor or an explicit rigging system.
- Large LED walls/screens must have plausible mounting/support.
- Decorative skins may conceal structure, but the concept should still read as physically supportable.

## Scale and geometry
- Human scale must remain credible.
- Counters, doors, chairs, tables, screens and activity equipment should have realistic proportions relative to people and the booth dimensions.
- Avoid impossible intersections, duplicated limbs/furniture, fused objects and penetrations through walls/floors.
- Avoid decorative geometry that makes normal use of a functional zone impossible.

## Functional completeness
When required by the brief, allocate and visually preserve:
- Reception/welcome point.
- Presentation/display area.
- Demo/product stations.
- Consultation/meeting area.
- Storage.
- Interactive/activity zone.
- Photo/branding area.
- Giveaway/brochure area.

The exact list is project-specific and comes from the confirmed structured brief.

## Branding and visual quality
- Make brand identity strong without overwhelming circulation/function.
- Use supplied logos/brand assets without unauthorised alteration where the provider allows reliable preservation.
- Follow the confirmed style direction while keeping exhibition construction plausible.
- Prefer deliberate lighting, material hierarchy and focal points over excessive decorative complexity.
- Avoid generic text gibberish where exact copy is required; use controlled graphic zones or later compositing for exact text.

## Budget-awareness prompt heuristics
When a budget is supplied, concept prompts should favour relative construction complexity appropriate to that budget.

MVP limitation: The system does not calculate construction cost. Budget-awareness is qualitative only.

Examples of lower-complexity choices:
- Modular wall systems.
- Reusable counters.
- Lightweight fascia.
- Printed graphics/lightboxes.
- Rental furniture/AV.
- Limited bespoke sculptural fabrication.

## Rigging language
If rigging is not confirmed, base concepts should prefer ground-supported structures.
If a concept uses apparent rigging, QA should flag it as requiring organiser/venue confirmation rather than treating it as approved.

## Visual QA severity
### Material failure
Candidate should be repaired once or clearly rejected/flagged.

Examples:
- Required major zone missing.
- Wrong number of explicitly required stations.
- Large object visibly outside footprint.
- Major floating/unsupported structure.
- Primary entrance blocked.
- Explicit prohibited branding/IP present.

### Warning
Candidate may still be shown but must be labelled.

Examples:
- Consultation clearance appears tight.
- Ambiguous support detail.
- Furniture scale slightly questionable.
- Budget complexity appears high.

### Pass
No material violation observable from the rendered view. Pass does not mean engineering or venue approval.

## Local edit preservation
For a user-masked edit:
- The requested mask is the only intended visual change region.
- Small contextual blending around the mask is acceptable.
- Branding, architecture, objects and composition outside the protected region should remain materially unchanged.
- If protected-region comparison shows substantial drift, reject/flag the result rather than silently replacing the revision.

## Prompt compiler rule
Every concept/refinement prompt is assembled from:
1. Confirmed project constraints.
2. Functional brief.
3. Brand/style direction.
4. These realism/buildability rules.
5. Camera/presentation intent.
6. Negative/prohibited constraints.

Users should not need to know or reproduce these rules themselves.
