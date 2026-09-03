# S7 - Accurate plan + editable 2D CAD handoff

Date: 2026-09-03
Status: accepted architecture/implementation contract
Repository: Swooshz-com/swooshz-design
Programme parent: #1
Current child: #28 - S7 Accurate plan + editable 2D CAD handoff

## Authority and current state

This document is the current-state S7 architecture and implementation contract. It is not a task log and it does not grant implementation, acceptance, merge, release, or progression authority.

The durable decision locks are:

DL-SD-S7-G1-001: ACCEPTED
DL-SD-S7-G2-001: ACCEPTED

The accepted authority chain is:

| Authority | Accepted evidence |
|---|---|
| Terminal S6 | #11 CLOSED / COMPLETED; PR #37 merged |
| Terminal S6 accepted G4 head | 5c2927a19ce57952fa999443f7792a67cd40e73e |
| Canonical main | 877a6ee81741be041f71bbcf36d385c64fda050d |
| Canonical tree | 4e73fd4675c63db80309daa5553ad194d35e441d |
| S7 G1 | DL-SD-S7-G1-001: ACCEPTED |
| Web G1 child receipt | 5511994922 |
| Web G1 parent transition | 5511998419 |
| S7 G2 | DL-SD-S7-G2-001: ACCEPTED |
| Web G2 controlling adjudication/corrections | 5513004637 |
| Web G2 parent transition | 5513007401 |

User/Web retains G2 finality, Ready, merge, canonical verification, G3 activation, repair authority, and programme progression. Workers and reviewers do not self-accept this document or the implementation that follows it.

S7 answers one bounded question:

Can an AutoCAD-compatible tool open an editable millimetre plan that accurately reflects the one accepted S6 spatial design, while retaining stable source-object correspondence and truthful lifecycle/integrity state?

S7 is a plan/correspondence export. It is design CAD, not fabrication or shop drawings, engineering certification, venue approval, or a 3D production scene.

## Tooling HOLD

TOOLING_HOLD: YES

The current environment has no suitable local version-pinned AutoCAD-compatible application available for representative open/import/edit/save/reopen evidence.

Exact disposition:

- The HOLD is nonblocking for G3 implementation and internal validation.
- The HOLD blocks S7 G4 acceptance/finality until representative local version-pinned CAD evidence exists.
- The HOLD consumes no ordinary repair budget.
- No cloud CAD service, remote CAD conversion, or hidden reader substitution may clear the HOLD.
- A later release evidence receipt is bound to the exact implementation head, writer/profile version, and representative fixture hashes.
- The HOLD is not a per-customer-export runtime dependency.

S8 #29 and S9 #30 remain outside this step and remain blocked by programme authority.

## Source authority and S6 boundary

S7 consumes exactly one live-current accepted S6 revision through:

~~~text
s6-to-s7-handoff-v1
~~~

The S6 handoff is read-only input. S7 has no S6 mutation capability and never edits an S6 model, approval, asset, event, revision, or history.

Each S7 export captures one immutable source binding containing all of the following values copied from the current handoff:

~~~text
handoffSchemaVersion = s6-to-s7-handoff-v1
projectId
acceptedRevisionId
acceptedRevisionHash
sourceS5Fingerprint
validationReceiptId
validationHash
validationOutcome
handoffDigest
~~~

The handoff digest is the SHA-256 of the canonical, independently normalized handoff payload with no artifact keys, private storage paths, timestamps, eligibility booleans, or generated CAD bytes. It is computed by S7 from the exact handoff bytes/values returned by S6 and is persisted with the source binding. A digest mismatch is a source failure, not a reason to choose another revision.

The accepted revision ID/hash, S5 fingerprint, validation receipt ID/hash, and handoff digest are runtime values. Documentation does not invent a placeholder revision or hash. Every export persists the exact values obtained from its admission read.

The S6 handoff eligibility object is snapshot evidence only:

~~~text
eligibility.currentAccepted
eligibility.sourceCurrent
eligibility.stale
~~~

S7 must independently re-read and fence the source. A true boolean in a previously returned handoff never replaces a fresh S6 read.

The live source must be re-read and compared with the captured binding at:

1. admission;
2. idempotency-key and job creation;
3. handoff projection and normalization;
4. geometry projection;
5. DXF generation;
6. staging writes;
7. promotion;
8. durable committed-state write;
9. export metadata/state disclosure;
10. download;
11. S7-to-S8 handoff disclosure.

The fence compares project ID, handoff schema version, handoff digest, accepted revision ID/hash, S5 source fingerprint, validation receipt ID/hash/outcome, and the canonical handoff shape. A mismatch aborts or marks the work stale and is never silently replaced with a new source.

Approved S6 hero/reference imagery is not geometry authority. S7 does not inspect pixels, reconstruct geometry from imagery, or reuse a renderer's tessellation. S6 local footprints are not world-plan geometry.

## Coordinate and world contract

The exact S6 world convention is:

~~~text
S6 origin = north-west floor corner
S6 X = east
S6 Y = up
S6 Z = south
right-handed
millimetres

DXF X = S6 world X
DXF Y = S6 world Z
DXF Z = 0
~~~

The booth envelope is the closed plan rectangle from world (0, 0, 0) to (widthMm, max-height-or-derived, depthMm). The DXF boundary is the closed rectangle from (0, 0) to (widthMm, depthMm). The boundary remains closed even when one or more booth sides are open.

S7 must independently implement the exact existing S6 full-Euler order and parent hierarchy composition. It may share types and the handoff contract, but the S7 geometry module must not make S6's already-computed local footprint its world-plan answer.

The existing S6 rotation order is intrinsic X, then Y, then Z. For millidegrees:

~~~text
rx = xMd * pi / 180000
ry = yMd * pi / 180000
rz = zMd * pi / 180000

after X:
  x1 = x
  y1 = y*cos(rx) - z*sin(rx)
  z1 = y*sin(rx) + z*cos(rx)

after Y:
  x2 = x1*cos(ry) + z1*sin(ry)
  y2 = y1
  z2 = -x1*sin(ry) + z1*cos(ry)

after Z:
  x3 = x2*cos(rz) - y2*sin(rz)
  y3 = x2*sin(rz) + y2*cos(rz)
  z3 = z2
~~~

For a local transform, the S7 affine has the translated origin and the three rotated local unit axes. For a child, composition is parent affine applied to the child origin and parent linear transform applied to each child axis. Parent traversal is recursive with cycle and dangling-parent rejection. Roots use their local affine directly. The result is cached only within the immutable handoff projection.

The parity oracle must compare independently calculated world points and projected boundaries against hand-authored reference calculations for roots, nested parents, X/Y/Z rotations, mixed rotations, center/floor anchors, and all three primitive families. Calling an S6 helper and asserting equality with itself is not independent validation.

## Exact projected solids

S7 emits the orthographic X/Z projection of the actual hierarchy-composed S6 solid. The contract is analytic/solid-based and deterministic. A renderer facet count is never an authoritative CAD boundary.

### Rectangular prism

For rect_prism, use all eight transformed solid corners:

~~~text
local x in {0, widthMm}
local y in {baseY, baseY + heightMm}
local z in {0, depthMm}
baseY = 0 for floor anchor
baseY = -heightMm / 2 for center anchor
~~~

Apply the complete parent-composed affine to every corner, discard world Y only after transformation, and compute the exact convex hull of all eight X/Z points. Deduplicate equal points and remove collinear interior points deterministically. Emit one closed LWPOLYLINE with the hull vertices in canonical winding. The hull is allowed to have fewer than eight projected points; it is never replaced with the untransformed local rectangle.

### Profile extrusion

For profile_extrusion, use the exact canonical S6 profile and both transformed extrusion planes:

~~~text
profile vertex = (local xMm, local zMm)
local y in {baseY, baseY + heightMm}
baseY = 0 for floor anchor
baseY = -heightMm / 2 for center anchor
~~~

Triangulation is an internal finite-union technique only. Triangulate the validated simple profile deterministically, project each triangular prism's six transformed vertices, and take the exact convex hull of each projected triangular prism. Compute the deterministic planar union of those convex pieces:

1. project every piece as line-segment boundaries;
2. split boundaries at every deterministic segment intersection;
3. cancel coincident opposite-oriented internal segments;
4. retain an oriented segment when its midpoint has the union on exactly one side;
5. stitch the retained segments into closed cycles;
6. choose cycle order by canonical minimum vertex and orientation;
7. remove duplicate and collinear points only after union;
8. emit the exact exterior cycles as closed LWPOLYLINE entities.

The union boundary, not the triangulation, is authoritative. Internal triangulation seams must not be emitted. Holes are not permitted by the accepted S6 profile contract; if a malformed or ambiguous union would require a hole, self-intersection, or non-deterministic arrangement decision, fail closed. Do not substitute a coarse polygon, renderer facets, a bounding box, or silent clipping.

### Round prism

The local round_prism axis is local Y. The S7 module projects the finite cylinder analytically.

For a plan-normal cylinder, the transformed axis is parallel to world Y and the transformed radial plane is the X/Z plane. Emit one exact CIRCLE with:

~~~text
center = projected transformed center of the base plane
radius = S6 radiusMm
~~~

For a general finite tilted cylinder, let c0 and c1 be the projected centers of the base and top planes, let d = c1 - c0, and let u and v be the projected transformed local X and Z radial basis vectors multiplied by radiusMm. The cross-section is the exact swept ellipse:

~~~text
E(t) = u*cos(t) + v*sin(t), 0 <= t < 2*pi
silhouette = E + [c0, c1]
~~~

When the 2D radial basis has rank two, emit the exact boundary of the Minkowski sum as two ELLIPSE arcs and two tangent LINE caps:

1. solve the tangent parameters from cross(E'(t), d) = 0;
2. select the two deterministic antipodal support/tangent parameters;
3. use the ELLIPSE center, major-axis vector, minor/major ratio, and exact start/end parameters for the two retained arcs;
4. join corresponding arc endpoints with tangent LINE entities from the base to the top;
5. orient and order arcs/lines by the canonical boundary winding;
6. retain the analytic ellipse parameters through quantized output formatting.

The ELLIPSE entity uses the R2000 center, relative major-axis endpoint, ratio, start parameter, and end parameter. It is not a many-sided approximation.

Rank-degenerate cases are represented exactly whenever the classification is deterministic:

- rank one radial projection: the ellipse is a line segment and its sweep is an exact parallelogram/hull; emit a closed straight-edge LWPOLYLINE after deterministic collinear cleanup;
- zero projected axis with a rank-one radial segment: emit the exact segment as a LINE, plus no fabricated area;
- rank zero or numerically ambiguous basis/classification: fail with a diagnostic round-classification error unless an exact representation is mathematically determined by the input;
- plan-normal circle classification is used only when the axis/radial conditions are proven within the fixed analytic tolerance.

There is no coarse polygon/facet fallback for a tilted round prism. Ambiguous analytic classification fails closed. A valid source shape is not silently boxed or clipped.

## Quantisation and numeric representation

The transport quantisation lock is:

~~~text
0.01 mm
~~~

All length coordinates, dimensions, radii, profile vertices, bounds, dimension positions, and plan offsets are represented internally as signed integer centi-millimetres before serialization. The canonical quantizer is:

~~~text
q(v) = floor(v * 100 + 0.5) when v >= 0
q(v) = ceil(v * 100 - 0.5) when v < 0
~~~

This is half-away-from-zero. A result of negative zero is normalized to zero. No length is serialized with exponent notation. Fixed formatting is locale-independent:

~~~text
formatLength(q) = sign + abs(q) div 100 + "." + two decimal digits(abs(q) mod 100)
zero = 0.00
~~~

Unitless ellipse ratios and radians use a separate deterministic fixed-decimal formatter with a finite decimal scale, no exponent notation, and normalized zero. Their scale is part of the writer version and is tested in golden fixtures. They are never confused with millimetre precision.

Transport precision is not fabrication accuracy. S7 must expose the distinction in metadata, UI copy, and documentation. It must not claim that 0.01 mm transport quantisation is a fabrication tolerance or engineering guarantee.

Every numeric input is finite, safe, bounded, and canonical before geometry or DXF generation. NaN, infinity, negative zero, non-integer S6 source dimensions, exponent-form transport strings, overflow, and out-of-bound parser coordinates fail closed.

The parser/output coordinate ceiling is:

~~~text
1_000_000_000 mm
~~~

This is only a defensive hard cap for parser and serializer work. It does not broaden canonical S6 source authority. Valid source values still have to come from the current accepted S6 handoff and pass S6/S7 schema and source-fence checks.

## AC1015 DXF contract

The writer profile is fixed:

~~~text
ASCII AutoCAD 2000 DXF
$ACADVER = AC1015
$INSUNITS = 4
$MEASUREMENT = 1
version = s7-dxf-r2000-ascii-v1
~~~

The bytes are ASCII, have LF line endings, have no BOM, use deterministic group-code ordering, and contain no locale-dependent output.

The only top-level section order is:

~~~text
HEADER
TABLES
BLOCKS
ENTITIES
EOF
~~~

CLASSES and OBJECTS remain omitted because S7 introduces no custom classes or required nongraphical objects.

### Tables

TABLES contains the following tables in this exact order:

~~~text
LTYPE
LAYER
APPID
BLOCK_RECORD
~~~

LTYPE precedes LAYER. LTYPE contains one deterministic CONTINUOUS entry used by every S7 layer. The entry has the AC1015 symbol-table and linetype-table-record subclass markers, name CONTINUOUS, flags 0, description Solid line, alignment code 65, element count 0, and total pattern length 0.

LAYER contains exactly these eleven entries in the listed order:

~~~text
S7-BOOTH-BOUNDARY
S7-BOOTH-OPENINGS
S7-WALLS-PARTITIONS
S7-ZONES
S7-FURNITURE
S7-EQUIPMENT
S7-DISPLAYS
S7-OVERHEAD
S7-DIMENSIONS
S7-LABELS
S7-UNKNOWN
~~~

Each layer has flags 0, color 7, linetype CONTINUOUS, and lineweight -1. The writer never creates a user-named layer from a project name, label, material, or URL.

APPID contains exactly one registered application:

~~~text
SWOOSHZ_S7
~~~

It has flags 0 and the required AC1015 symbol-table and registered-application subclass markers.

BLOCK_RECORD contains exactly two entries:

~~~text
*MODEL_SPACE
*PAPER_SPACE
~~~

Each has the required AC1015 symbol-table and block-table-record subclass markers and flags 0. The matching minimal definitions are present in BLOCKS. All graphical entities are owned by the *MODEL_SPACE BLOCK_RECORD, never *PAPER_SPACE.

### Block definitions

BLOCKS contains exactly one minimal block definition for *MODEL_SPACE and one for *PAPER_SPACE. Each definition has a deterministic BLOCK begin handle, its matching BLOCK_RECORD owner, the AC1015 entity/block-begin subclass markers, name, flags 0, origin 0/0/0, and matching ENDBLK handle with its block-record owner and entity/block-end subclass markers.

There are no user blocks, XREFs, nested block content, proxy objects, executable content, or script strings. No graphical entity is placed inside the block definitions; all S7 graphics are in ENTITIES and owned by *MODEL_SPACE.

### Common entity fields

Every graphical entity begins with these exact common fields before its entity-specific data:

~~~text
5    deterministic handle
330  *MODEL_SPACE BLOCK_RECORD owner handle
100  AcDbEntity
410  Model
8    one locked S7 layer
370  -1
100  entity-specific subclass
~~~

370 = -1 means ByLayer. The owner handle, layer, subclass marker, and all entity data are read back and checked. No entity omits the common metadata because it is visually understandable.

Each graphical entity also carries bounded XDATA under APPID SWOOSHZ_S7. XDATA is a locator, not a second manifest and not a place for arbitrary user text.

### Deterministic handle allocation

The earlier G2 proposal's fixed numeric handle assumptions are superseded. The implementation uses one map for tables, table entries, block records, block definitions, and entities:

| Allocation | Handle rule |
|---|---|
| LTYPE TABLE control | 100 |
| CONTINUOUS LTYPE entry | 101 |
| LAYER TABLE control | 110 |
| LAYER entry i, i = 0..10 | 111 + i |
| APPID TABLE control | 120 |
| SWOOSHZ_S7 APPID entry | 121 |
| BLOCK_RECORD TABLE control | 130 |
| *MODEL_SPACE BLOCK_RECORD entry | 131 |
| *PAPER_SPACE BLOCK_RECORD entry | 132 |
| *MODEL_SPACE BLOCK begin | 140 |
| *MODEL_SPACE ENDBLK | 141 |
| *PAPER_SPACE BLOCK begin | 142 |
| *PAPER_SPACE ENDBLK | 143 |
| graphical entity i, in canonical emission order | 200 + i |

Handles are emitted as uppercase hexadecimal strings without a prefix. The entity list is built before serialization, so the first unused handle is:

~~~text
HANDSEED = uppercase-hex(0x200 + graphicalEntityCount)
~~~

$HANDSEED equals that first unused handle exactly. No handle is reused, skipped within a reserved allocation range, or assigned from a random UUID. XDATA locators do not allocate handles.

### Entity-specific writers

The v1 writer supports only these graphical entity types:

| Entity | Required entity-specific data and semantics |
|---|---|
| LWPOLYLINE | AcDbPolyline; vertex count 90; flags 70; optional elevation 38 = 0; repeated quantized 10/20 vertices; 42 omitted for straight edges; 70 = 1 for closed boundaries |
| CIRCLE | AcDbCircle; center 10/20/30; radius 40; 30 = 0 |
| ELLIPSE | AcDbEllipse; center 10/20/30; relative major axis endpoint 11/21/31; ratio 40; start parameter 41; end parameter 42; 30/31 = 0 |
| LINE | AcDbLine; start 10/20/30 and end 11/21/31; all Z values 0 |
| TEXT | AcDbText; insertion 10/20/30; height 40; bounded sanitized ASCII text 1; Standard text style 7; deterministic rotation 50; Z values 0 |
| POINT | AcDbPoint; position 10/20/30; Z = 0 |

All planar entity coordinates use DXF X = world X, DXF Y = world Z, and DXF Z = 0. LWPOLYLINE vertices are written in canonical cycle order. ELLIPSE arc parameters are normalized to a deterministic range and use the exact analytic arc endpoints. TEXT never contains control characters, CR/LF, executable syntax, URLs, or unbounded source labels.

The writer does not emit 3D solids, meshes, faces, SPLINE entities, DIMENSION entities, HATCH entities, raster references, PDFs, DWG bytes, or arbitrary user-supplied DXF.

## Layers and plan semantics

The booth envelope is always a closed LWPOLYLINE on S7-BOOTH-BOUNDARY. Open sides are not holes in the envelope and are not represented by deleting boundary segments.

Open-side semantics are separate:

- S7-BOOTH-OPENINGS contains one deterministic marker set for each S6 open side, ordered north, east, south, west.
- S7-LABELS contains a bounded OPEN-NORTH/EAST/SOUTH/WEST marker only for an open side.
- S7-WALLS-PARTITIONS contains modeled walls/partitions from the accepted S6 objects only.
- No wall is synthesized on an open side. The absence of a wall remains meaningful.

The layer mapping is:

| Layer | Content |
|---|---|
| S7-BOOTH-BOUNDARY | closed booth envelope |
| S7-BOOTH-OPENINGS | open-side marker lines/points |
| S7-WALLS-PARTITIONS | S6 wall and partition projections |
| S7-ZONES | named functional-zone boundaries/markers |
| S7-FURNITURE | furniture and counters |
| S7-EQUIPMENT | equipment and storage |
| S7-DISPLAYS | displays, plinths, and screens |
| S7-OVERHEAD | overhead geometry shown in plan and marked by role |
| S7-DIMENSIONS | deterministic width/depth and useful object dimensions |
| S7-LABELS | bounded human-readable role/zone/opening labels |
| S7-UNKNOWN | explicit unresolved/diagnostic markers; never invented geometry |

Source objects are sorted by stable objectId/identityKey, not source array order. A profile union may create several cycles, arcs may create several entities, and each emitted part has a zero-based partIndex. A stable entity is never matched by display order alone.

Out-of-envelope geometry that is valid in the accepted source remains represented. S7 records an out-of-envelope diagnostic in the private manifest/readback result and telemetry; it does not clip, shrink, move, or hide the geometry. Only malformed source, unsupported/ambiguous analytic classification, invalid numeric data, or failed independent validation causes a closed failure.

Unknowns remain explicit. S7-UNKNOWN may carry a POINT and sanitized TEXT describing an unknown ID/category, but it never becomes a made-up rectangle, circle, wall, label, or requirement fulfillment.

## Identity and private manifest

The fixed APPID is:

~~~text
SWOOSHZ_S7
~~~

The private immutable manifest is the complete correspondence authority. It is stored beside the final DXF under a private immutable object key and is never returned as a public storage path.

Each manifest entity contains at minimum:

~~~text
sourceObjectId
identityKey
parentObjectId
role
partIndex
geometryState
sourceRevisionId
sourceRevisionHash
~~~

It also contains entityHandle, entityType, layer, xdataEntityKey, geometryDigest, quantized bounds, and a derived/diagnostic marker. Source object records use the exact S6 identityKey, parentObjectId, role, and geometryState. Derived booth/opening/dimension/label/unknown records use sourceObjectId = null and a deterministic identityKey such as booth-envelope or opening-north while retaining the same source revision fields. This makes derived records explicit rather than pretending they are S6 objects.

The manifest includes the source binding, DXF writer/profile version, layer list, deterministic entity order, exact quantized entity parameters, source object counts, open-side set, and diagnostics. It does not contain image bytes, prompts, secrets, credentials, private storage values, or arbitrary raw customer text.

XDATA is a compact bounded locator:

~~~text
1001 SWOOSHZ_S7
1000 s7-loc-v1
1000 m=<manifest-sha256>;e=<entity-key>
~~~

The entity key is a deterministic short digest over sourceObjectId, partIndex, role, sourceRevisionId, and sourceRevisionHash. The locator is bounded to the DXF XDATA string limit, contains only safe ASCII, and points to the private manifest. Full correspondence remains in the manifest; XDATA is not trusted without manifest/readback verification.

## Validation separation

S7 has two distinct validation layers.

### Runtime per-export validation

Every canonical customer export requires all of the following:

- a live-current S6 source fence;
- deterministic source normalization and geometry generation;
- exact projected-solid algorithms for every emitted primitive;
- strict independent raw-DXF readback;
- exact manifest/entity correspondence;
- source binding equality;
- SHA-256 and byte-size integrity for DXF and manifest;
- private staging and immutable final promotion;
- a committed immutable final object;
- a final live-current fence before metadata, download, or S7-to-S8 disclosure.

This internal validation gates runtime download and S7-to-S8 handoff. A runtime export never requires a human to open it in external CAD.

### Gate/release interoperability evidence

Representative local CAD evidence validates the writer/profile implementation itself. It is not required manually for each user export.

The product runtime does not add cadEvidenceId or cadEvidenceStatus to S7CadExport. The product StoreState does not add an s7CadEvidence collection. If the release lane retains a schema named s7-cad-evidence-v1, it is a G3/G4/release evidence receipt only, bound to the exact implementation head, writer/profile version, parser version, and representative fixture hashes. It is not user-project runtime authority and is not a per-export metric.

The current tooling HOLD exists because no suitable local version-pinned AutoCAD-compatible application is available. Cloud CAD substitution is not equivalent evidence.

## Lifecycle, security, and privacy

S7 uses the existing JsonRepository, PrivateObjectStore, AppError, privateStorageKey, exact hash, authorization, and idempotency primitives where their existing contracts apply. It does not add a standalone publication module unless a later accepted decision proves an existing primitive insufficient; the planned S7 service owns the bounded publication transitions.

Lifecycle invariants are:

- staging is private;
- final promotion is immutable and no-overwrite;
- exact SHA-256 and byte-size are verified before and after promotion;
- repeated requests with the same operation/key/input hash replay the same durable result;
- every export has at most two attempts;
- dead-owner recovery is liveness-safe and never steals a live/unknown owner;
- stale or superseded source bindings cannot commit or disclose;
- authorization runs before project, source, metadata, manifest, storage-key, or download disclosure;
- download uses a fixed safe ASCII filename and private/no-store/nosniff headers;
- parser/entity/vertex/XDATA/string/byte work is bounded;
- public errors are generic and carry a support-safe reference ID;
- logs contain only privacy-minimized IDs, operation/status/code/attempt and safe hashes where required;
- logs never contain prompts, uploads, image bytes, model payloads, credentials, auth headers/cookies, storage keys, raw DXF, private connector data, or unnecessary PII.

No fallback fabricates a success state, chooses a different source, boxes unsupported geometry, silently clips a valid solid, or downgrades an integrity failure.

## Telemetry

S7 telemetry is derived from durable S7 events/jobs and has exact-zero semantics. Unavailable values are not represented as zero.

The fixed runtime telemetry shape is:

~~~ts
type S7Metric<T> = {
  availability: "available" | "unavailable";
  value: T | null;
  reason: string | null;
};

type S7Telemetry = {
  schemaVersion: "s7-telemetry-v1";
  projectId: UUID;
  sourceReadiness: S7Metric<"ready" | "not_ready">;
  exportRequestCount: S7Metric<number>;
  exportSuccessCount: S7Metric<number>;
  exportFailureCount: S7Metric<number>;
  readbackFailureCount: S7Metric<number>;
  publicationFailureCount: S7Metric<number>;
  staleFenceCount: S7Metric<number>;
  retryCount: S7Metric<number>;
  committedExportCount: S7Metric<number>;
  committedDxfByteSize: S7Metric<number>;
  providerCost: S7Metric<number>;
  toolCost: S7Metric<number>;
  generatedAt: Timestamp;
};
~~~

providerCost is always unavailable with reason no_provider_used. toolCost is always unavailable with reason no_billed_tool_amount. External CAD evidence is not represented as a project/export runtime metric.

## S8 boundary

The typed boundary is locked as:

~~~text
s7-to-s8-handoff-v1
~~~

S8 receives a DTO containing the current S6 source binding, the committed S7 artifact identity/hash/size, the private-manifest correspondence summary, units, open sides, and stable object correspondence. The DTO explicitly marks:

~~~text
threeDGeometryAuthority = s6-to-s7-handoff-v1
planEvidence = s7-dxf-r2000-ascii-v1
~~~

S8 must continue to consume the same accepted S6 model for 3D authority. The S7 DXF is plan/correspondence evidence only; it is not a replacement spatial model and must not become the 3D source by reverse parsing.

No FBX generation, 3ds Max generation, .max handling, editable 3D scene, 3D production artifact, APS integration, or S8 production work belongs in S7.

## Scope boundary and flags

This accepted contract authorizes documentation canonicalisation only in the current G2 step. It does not authorize product/runtime/test implementation in this change, G3 activation, G4 acceptance, merge, finality, tooling-HOLD clearance, deployment, credentials, external CAD calls, or customer data.

Current flags:

~~~text
GATE_REENTRY_REQUIRED: NO
PARENT_RECONCILIATION_INCOMPLETE: NO
NON_CONVERGENCE_DECISION_REQUIRED: NO
SECRET_EXPOSURE_DETECTED: NO
TOOLING_HOLD: YES
~~~

## ELI5

S6 is the one trusted booth model. S7 makes a careful 2D plan from that model, keeps every object traceable, checks the file by reading its raw bytes back, and stores it privately without overwriting anything. The missing CAD program does not stop coding or internal checks, but real CAD open/edit/save proof is still required before S7 can be called final.
