# S7 G2: Accurate editable 2D CAD handoff

Status: canonical S7 G2 architecture and product contract.

This specification and the companion implementation plan are one contract. The
plan is the single detailed definition of persisted TypeScript records, API
routes, storage formulas, state transitions, the implementation file map, and
later G3 validation. This specification defines the stable authority,
geometry, format, security, lifecycle, validation, and S7-to-S8 boundaries.

## 1. Authority and scope

The binding programme authority is:

- Parent: GitHub issue #1.
- Current child: GitHub issue #28, S7 Accurate plan + editable 2D CAD handoff.
- `DL-SD-S7-G1-001: ACCEPTED`.
- `DL-SD-S7-G2-001: ACCEPTED`.
- G1 Web receipt: `5511994922`; parent transition: `5511998419`.
- G2 Web adjudication and controlling corrections: `5513004637`; parent transition: `5513007401`.
- Clean publication disposition: `S7_G2_CANONICAL_PUBLICATION_REBUILD: AUTHORISED`.
- Clean-rebuild child authority: `5520022432`; parent authority: `5520023968`.

The canonical base is main commit
`877a6ee81741be041f71bbcf36d385c64fda050d` with tree
`4e73fd4675c63db80309daa5553ad194d35e441d`. This pair is a clean bounded
reconstruction from the accepted locks and Web correction receipt. It is not a
patch-on-patch continuation of an earlier candidate.

G2 publishes documentation only. It authorises no S7 runtime, product, test,
dependency, generated-file, CAD-tooling, S8, or S9 implementation. G3 remains
blocked until this exact pair is accepted and canonically merged. G4/finality
remains separately blocked by `TOOLING_HOLD: YES`.

The contract must preserve one canonical definition for each persisted field,
version, path, state transition, and runtime identity. A later section or the
implementation plan references that definition instead of creating an alias.

## 2. Source authority and admission

S7 consumes exactly one live-current accepted S6 revision through
`s6-to-s7-handoff-v1`. The accepted S6 canonical spatial model is the only 3D
source of geometry. Approved imagery, labels, and visual intent cannot replace
confirmed S6 facts or accepted S6 spatial geometry. S7 never reconstructs
geometry from an image.

The exact persisted `S7SourceStamp` is defined once in the companion plan. It
binds the S6 revision, S6 content hash, S5 fingerprint, S6 validation receipt,
validation hash, handoff schema, and handoff digest. Eligibility booleans are
snapshot evidence only; they are never a live source fence.

Live source validation and fencing are required at all of these boundaries:

- admission;
- job and idempotency creation;
- projection;
- generation;
- staging;
- promotion;
- commit;
- metadata disclosure;
- download;
- S7-to-S8 disclosure.

Every boundary rereads the accepted current source and rejects a changed,
missing, invalid, or superseded source. A captured source is not made current
by a stale eligibility flag.

## 3. Version roles

The following literals are exact and each has one role:

| Version | Role |
| --- | --- |
| `s7-cad-export-v1` | persisted export record |
| `s7-cad-job-v1` | persisted worker-job record |
| `s7-cad-manifest-v1` | immutable private correspondence manifest |
| `s7-cad-readback-v1` | raw readback parser/result |
| `s7-cad-validation-receipt-v1` | durable internal validation receipt |
| `s7-cad-idempotency-v1` | persisted export idempotency record |
| `s7-dxf-r2000-ascii-v1` | deterministic ASCII AutoCAD 2000 DXF profile |
| `s7-world-to-plan-v1` | S6 world-to-plan coordinate transform |
| `s7-to-s8-handoff-v1` | S7-to-S8 runtime handoff DTO |
| `s7-telemetry-v1` | derived S7 telemetry schema |

`s7-cad-evidence-v1`, if used, is release/G3/G4 evidence for the exact writer,
profile, head, and fixture set. It is not a product-project runtime record,
per-export authority, or download prerequisite.

## 4. Geometry contract

S7 projects the complete hierarchy-composed S6 solid. It implements and tests
the S6 X -> Y -> Z Euler order and parent hierarchy through an independently
constructed matrix oracle. The oracle must not call or compare a function to
itself; it independently multiplies the matrices and verifies the composed
world transform.

### Coordinate convention

```
Origin: north-west floor corner
X: east
Y: up
Z: south
Right-handed
Units: millimetres

DXF X = S6 world X
DXF Y = S6 world Z
DXF Z = 0
```

The convention version is `s7-world-to-plan-v1`. The plan frame is the S6 world
floor projection, not a local footprint copied from an individual source node.

### Locked layer order

Canonical source-geometry sorting uses this exact ordered allowlist as the
locked layer order:

```
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
```

No alternate layer order is valid. The role-to-layer mapping below remains the
semantic mapping for source roles.

### Booth envelope and open sides

The booth envelope is one closed plan boundary even when one or more sides are
open. Open sides are separate semantic/opening-marker entities on
`S7-BOOTH-OPENINGS`; an open side does not delete the booth-envelope boundary.
No wall is synthesized merely because a booth side exists. The absence of a
modeled wall on an open side remains meaningful.

Opening-marker groups are emitted in deterministic `north`, `east`, `south`,
`west` order. Where open-side labels are emitted, they are deterministic derived
labels and never fabricated geometry.

### Primitive projection

- `rect_prism`: transform all eight solid corners, project world X/Z, and
  compute the exact deterministic convex hull. An area hull is a closed
  `LWPOLYLINE`; an exact two-point degeneration is a `LINE`; an exact one-point
  degeneration is a `POINT`.
- `profile_extrusion`: project the complete extruded solid and compute its exact
  deterministic union boundary. Triangulation may be internal, but internal
  triangulation seams never become authoritative output boundaries. Multiple
  exact exterior loops are valid where required. Invalid or ambiguous topology
  fails closed.
- `round_prism`:
  - a proven plan-normal case is an exact `CIRCLE`;
  - a full-rank (rank-two) tilted radial projection is analytic `ELLIPSE` arcs
    plus tangent `LINE` caps;
  - a rank-one radial projection with nonzero projected cylinder axis is the
    exact closed straight-edge projected hull as an `LWPOLYLINE`;
  - a rank-one radial projection with zero projected cylinder axis is the exact
    segment as a `LINE`;
  - a mathematically proven rank-zero case is the exact axis segment or point,
    using `LINE` or `POINT` as applicable;
  - an ambiguous or unproved analytic classification fails closed.

  No sampled polygon, facet or faceted fallback, bounding box, silent clipping,
  or fabricated area is allowed.

No booth clipping is applied to make an invalid source appear valid. Unknown
or unresolved geometry remains explicit and never receives invented geometry.

### Dimensions, labels, and unknowns

Editable width/depth dimension groups are exploded line and text entities with
fixed deterministic placement. Confirmed maximum height is informational text
only. Derived values are marked as derived. There is no collision solver or
reflow; overlap is informational. The DXF never makes fabrication,
engineering, structural, venue-certification, or equivalent claims.

Source geometry with `geometryState = bounded_inference`, or with relevant
unresolved source unknowns, emits primary geometry on `S7-UNKNOWN`. The private
manifest retains the intended semantic layer and the unresolved source facts.
S7 does not invent coordinates, dimensions, identity, or geometry to avoid an
unknown.

## 5. Numeric and transport rules

Transport precision is `0.01 mm`; it is not fabrication accuracy. Quantisation
is deterministic, half-away-from-zero, locale-independent, and never emits
negative zero. Exponent notation is forbidden. Whole-centimetre values may be
serialized as integers. Fractional millimetre values serialize with exactly
two fractional digits. `ELLIPSE` ratio, start, and end parameters serialize
with exactly twelve fractional places.

The serializer uses one canonical byte representation for all derived numeric
values. The parser accepts only the bounded v1 representation and rejects
ambiguous or non-canonical values rather than silently normalizing them.

## 6. DXF profile

S7 emits only deterministic ASCII AutoCAD 2000 DXF:

```
ASCII AutoCAD 2000
$ACADVER = AC1015
$INSUNITS = 4
$MEASUREMENT = 1
version = s7-dxf-r2000-ascii-v1
```

The exact section order is:

```
HEADER
TABLES
BLOCKS
ENTITIES
EOF
```

`HEADER` includes `$ACADVER`, `$INSUNITS`, `$MEASUREMENT`, `$EXTMIN`,
`$EXTMAX`, and `$HANDSEED`. Extents cover emitted plan geometry and annotation
insertion points. `$HANDSEED` is the first unused handle.

`TABLES` contains, in this order, `LTYPE`, `LAYER`, `APPID`, and
`BLOCK_RECORD`. `LTYPE` precedes `LAYER`. `BLOCK_RECORD` contains deterministic
`*MODEL_SPACE` and `*PAPER_SPACE` records. `BLOCKS` contains matching minimal
definitions for those records. No user blocks or XREF content is added.

All graphics are model-space entities. Each graphical entity includes:

```
5    deterministic handle
330  model-space BLOCK_RECORD owner
100  AcDbEntity
410  Model
8    locked S7 layer
370  -1
100  entity-specific subclass
```

One deterministic non-overlapping handle allocation covers tables, table
entries, block records, block definitions, and graphics. `CLASSES` and
`OBJECTS` remain omitted because S7 introduces no custom class or nongraphical
object requirement. The writer emits no XREF, proxy, script, 3D solid, mesh,
raster/PDF, or DWG content.

## 7. Identity, XDATA, manifest, and text safety

The APPID is `SWOOSHZ_S7`. Every graphical entity carries the accepted compact
identity grammar:

```
1001 SWOOSHZ_S7
1000 S7V1
1000 O=<sourceObjectId>
1000 K=<identityKeyToken-or-hash>
1000 P=<parentObjectId-or->
1000 R=<role>
1000 I=<partIndex>
1000 G=<geometryState>
1000 V=<sourceRevisionId>
1000 H=<sourceRevisionHash>
```

`sourceObjectId` and `parentObjectId` are opaque stable S6 identifiers and are
not constrained to UUID syntax. A compact manifest locator may coexist only
within the bounds and may not replace this accepted in-file identity block.
The exact bound is `XDATA strings/entity = 16`.

Private manifest bytes are immutable and authoritative for complete
source/entity correspondence. Durable linkage binds the manifest schema,
manifest/project/artifact identities, the complete `S7SourceStamp`, both DXF
and world-to-plan versions, manifest hash and byte size, and the private object
identity. The final manifest is a separate private object with its own accepted
path; it is not described as colocated with the final DXF. The exact final and
staging formulas are defined once in the companion plan.

DXF text is printable ASCII only. Reject C0 and C1 controls, CR, LF inside a
field, NUL, Unicode DXF escape sequences in v1, unsafe backslash injection, and
arbitrary raw customer text. Derived non-ASCII labels use deterministic
`_uXXXX_` encoding or a stable identity hash. Labels are at most 120 code
points. No collision solver or reflow is introduced.

Locked layer mapping is:

```
booth_floor       -> S7-BOOTH-BOUNDARY
booth_wall        -> S7-WALLS-PARTITIONS
booth_partition   -> S7-WALLS-PARTITIONS
zone              -> S7-ZONES
furniture         -> S7-FURNITURE
storage           -> S7-FURNITURE
seating           -> S7-FURNITURE
equipment         -> S7-EQUIPMENT
display           -> S7-DISPLAYS
screen            -> S7-DISPLAYS
overhead          -> S7-OVERHEAD
```

If the source geometry is bounded inference or has relevant unresolved
unknowns, primary emitted geometry uses `S7-UNKNOWN`; the private manifest
retains the intended semantic layer.

After the closed booth boundary and opening markers, canonical entity order is
the exact locked layer order defined above, then `identityKey` UTF-8 byte order,
then `partIndex`, then entity type rank. Dimensions follow, then source labels,
then unknown diagnostics. Source array order and mutable presentation order are
not entity identity.

## 8. Lifecycle, integrity, and security

The primary publication path is queued -> running -> staged -> promoted ->
committed. A running, staged, or promoted job may enter `failed_retryable` and
return to queued exactly once for attempt 2. Before finality, queued/running/
staged/promoted becomes `stale` when its captured source is invalid. After
finality, committed becomes `superseded` when a newer accepted S6 revision is
current. `stale` and `superseded` are distinct historical outcomes. The exact
persisted state union and no-return rules are defined once in the companion
plan.

The maximum number of attempts is 2. Terminal states are `stale`,
`superseded`, `failed_terminal`, and `aborted`. No terminal state is silently
reopened. A committed record may leave only through the explicit committed to
superseded historical transition.

All staging and final objects are private and immutable. Promotion never
overwrites an existing final object. Hash, byte-size, object-presence, source,
manifest, and receipt checks are required before publication or disclosure.
Authorization runs before existence, project, artifact, or storage disclosure.

The HTTP `Idempotency-Key` is a bounded opaque string. The server never parses
it as a UUID. The same key with the exact same accepted request, source, and
input is a replay of the original job and artifact. The same key with any
different request, source, or input returns `S7_IDEMPOTENCY_CONFLICT`.
`requestReferenceId`, where required by existing API/error conventions, is a
separate UUID and is never the idempotency key.

The full live source fence applies at admission, creation, projection,
generation, staging, promotion, commit, metadata, download, and handoff. A
worker claim uses an opaque UUID claim token, owner-process identity, heartbeat,
and bounded recovery. Live or uncertain ownership is not reclaimed; recovery
can act only on definitely dead ownership and stays within the resource bound.

## 9. Readback and release evidence

The raw parser/result version `s7-cad-readback-v1` and durable receipt version
`s7-cad-validation-receipt-v1` are distinct. The durable receipt binds the
receipt, project, artifact, complete source stamp, manifest identity/hash,
world-to-plan version, DXF version, DXF SHA-256 and byte size, entity count,
correspondence result, outcome, issues, check time, and receipt hash. The
receipt hash is SHA-256 over canonical receipt content with `receiptHash` blank.

The writer and readback parser are independent implementations. A readback
PASS requires strict parsing of the bounded v1 profile, exact source and
manifest correspondence, exact hash and byte size, entity and resource limits,
and final-object integrity. Runtime export, download, and handoff require
authorization, a live-current S6 source, a committed immutable artifact,
passing internal readback, exact hashes and sizes, and exact final objects.

Representative local CAD evidence still requires open/import/edit/save/reopen of
a representative local CAD scratch copy. The CAD application's edited/saved
scratch copy does not need to remain canonical-byte-identical to the original
S7 writer bytes. Canonical product writer bytes remain governed by deterministic
internal readback/hash/size rules. External CAD evidence proves
interoperability/editability, not reproduction of canonical writer bytes after
the CAD application saves them.

This evidence validates the writer and profile at G3/G4/release level for
pinned representative fixtures. It is not a manual per-export runtime
dependency and does not become a runtime project field, runtime authority, or
download prerequisite. No cloud CAD substitution is allowed.
`TOOLING_HOLD: YES` remains governance/release state only, nonblocking for G2
and G3, and blocking for G4/finality until the required version-pinned local
evidence exists.

## 10. S7-to-S8 boundary

The runtime handoff uses one flat top-level identity contract, defined once in
the companion plan. It binds the current project, accepted S6 revision and S5
fingerprint, committed S7 artifact hash/size, immutable manifest hash, passing
readback receipt hash, both format versions, the coordinate convention, and
explicit S6-as-3D-authority semantics.

S8 must read the same accepted S6 model as 3D authority. S7 DXF is plan and
correspondence evidence only; it is not 3D authority. S7 implements no S8 3D,
FBX, or 3ds Max production logic.

## 11. Resource and defensive bounds

The following bounds are exact. The plan coordinate ceiling is defensive only;
it does not broaden S6 authority.

```
DXF bytes:                  8,000,000
DXF lines:                  200,000
group/value line:           512 bytes
entities:                   4,096
vertices:                   16,384
layers:                     32
table records:              64
label length:               120 code points
XDATA/entity:               2,048 bytes
XDATA strings/entity:       16
manifest bytes:             4,000,000
readback receipt bytes:     256,000
CAD release evidence:       32,768 bytes
plan coordinate magnitude:  1,000,000,000 mm
recovery items/pass:        256
attempts:                   2
```

Any limit breach fails closed. There is no silent truncation, broad fallback,
synthetic geometry, or hidden conversion path.

## 12. Boundary and progression

G2 is complete only when the companion plan and this specification agree on
the accepted contract and the docs-only publication contains exactly these two
documents. No product/runtime/test implementation, CAD installation, cloud
CAD call, S8/S9 work, Ready transition, merge, or G3 execution is authorised by
this document. G3 later validates the accepted writer and runtime map; G4 adds
the required representative local CAD evidence before S7 finality.
