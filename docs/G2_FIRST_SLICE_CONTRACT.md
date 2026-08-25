# G2 First-Slice Implementation Contract

Decision Lock: DL-SD-MVP-G2-001

Status: normative contract for G3

Canonical base at admission: 2d6afeac423d4f09cbf702106ebeacf754ae7304

Prepared branch: web/run-002-g2-first-slice-contract

Reviewed on: 2026-08-25

## 1. Purpose and locked boundary

This document is the complete G2 implementation contract for the first
vertical slice of the Swooshz Design v0.1 MVP:

create project -> mandatory booth geometry -> upload one brief ->
structured extraction -> user confirmation -> deterministic prompt
compilation -> four concept generations -> persist candidates

The words MUST, MUST NOT, SHOULD, and MAY are normative. G3 MUST implement
the behavior in this document without adding product decisions.

The slice ends when one immutable generation set contains four immutable
concept candidates. It does not include:

- buildability QA or automatic repair;
- concept selection, refinement, or revision UI;
- masked editing;
- Concept Layout Plan;
- presentation PDF;
- 3D, Autodesk APS, 3ds Max, or `.max`;
- exact multi-angle rendering;
- costing;
- venue databases or venue approval;
- billing;
- CRM;
- white-label or enterprise permissions;
- multi-provider routing;
- a second brief or multiple brief assets per project.

Buildability-aware language in this slice is limited to prompt-time visual
realism and plausibility constraints. It MUST NOT be presented as
engineering, fabrication, structural, fire, accessibility, code, or venue
approval.

## 2. Contract conventions

- JSON field names use camelCase.
- IDs are UUID v4 strings.
- Timestamps are UTC RFC 3339 strings with a `Z` suffix.
- Hashes are lowercase SHA-256 hex strings with 64 characters.
- Absent optional values are `null`; they are not omitted.
- Arrays have a defined order and MUST NOT be reordered by a client.
- Integer dimensions are stored in millimetres. No floating-point dimension
  is persisted.
- User-uploaded text is reference data, not executable instructions.
- The server is authoritative for geometry, version numbers, statuses,
  compiler inputs, idempotency, and provider credentials.
- No G2 user or enterprise permission model is introduced. Route access
  follows the existing private application boundary; an unknown project ID
  returns a generic not-found response.

Every API error uses this shape:

~~~json
{
  "error": {
    "code": "SAFE_MACHINE_CODE",
    "message": "Something went wrong. Reference: 2e5b0c2d-5d27-4e4c-9f12-7d6e3f8c1a40. Try again.",
    "referenceId": "2e5b0c2d-5d27-4e4c-9f12-7d6e3f8c1a40",
    "fieldErrors": []
  }
}
~~~

The example UUID is illustrative only. A fresh reference ID MUST be
generated for each failed request. Field validation may return safe field
codes and labels, but MUST NOT return provider internals, uploaded content,
prompts, generated output, credentials, or stack traces.

## 3. Routes, screens, and transitions

### 3.1 Application routes

| Route | Screen | Entry condition | Successful transition |
| --- | --- | --- | --- |
| `/projects/new` | Create Project | No project is selected | `POST /api/projects` returns `201`; navigate to `/projects/{projectId}/geometry` |
| `/projects/{projectId}/geometry` | Booth Geometry | Project exists and is not confirmed or generating | Valid `PUT /api/projects/{projectId}/geometry`; navigate to `/projects/{projectId}/brief` |
| `/projects/{projectId}/brief` | Upload Brief | Geometry is valid, no brief is confirmed, and either no asset exists or the existing asset has failed extraction | Accepted PDF is stored and extraction starts; remain on this route while extracting; navigate to `/projects/{projectId}/brief/review` on valid extraction |
| `/projects/{projectId}/brief/review` | Review Structured Brief | A valid extraction draft exists | Valid `POST /api/projects/{projectId}/brief/confirm`; navigate to `/projects/{projectId}/generate` |
| `/projects/{projectId}/generate` | Generate Four Concepts | A confirmed brief version exists and no generation set has succeeded | Accepted generation request; navigate to `/projects/{projectId}/generations/{generationSetId}` |
| `/projects/{projectId}/generations/{generationSetId}` | Generation Progress and Results | Generation set belongs to the project | Stay on this route while queued/running; show four candidates only after the set succeeds |

G3 MUST use the route parameter names exactly as shown. There are no G2
routes for editing a confirmed brief, selecting a concept, QA, repair,
refinement, masks, layout plans, PDFs, 3D, or administration.

### 3.2 API operations and request bodies

The route screens use these server operations:

| Method and path | Request | Result |
| --- | --- | --- |
| `POST /api/projects` | `{ "name": string \| null }` | Creates a draft project |
| `PUT /api/projects/{projectId}/geometry` | `BoothGeometry` | Replaces draft geometry only after server validation |
| `POST /api/projects/{projectId}/brief` | Multipart form with exactly one `file` part and an `Idempotency-Key: UUID` header | Stores one PDF asset and starts extraction |
| `GET /api/projects/{projectId}/brief/draft` | None | Returns the current extraction draft |
| `PATCH /api/projects/{projectId}/brief/draft` | `{ "data": StructuredBriefData, "expectedRevision": integer }` | Saves one editable draft revision |
| `POST /api/projects/{projectId}/brief/confirm` | `{ "draftId": UUID, "expectedRevision": integer }` plus an `Idempotency-Key: UUID` header | Creates the immutable confirmed version |
| `POST /api/projects/{projectId}/brief/extraction-retry` | `{ "assetId": UUID, "idempotencyKey": UUID }` | Retries extraction for the same stored asset |
| `POST /api/projects/{projectId}/generation-sets` | `{ "idempotencyKey": UUID }` | Creates or returns the one generation set for the confirmed version |
| `GET /api/projects/{projectId}/generation-sets/{generationSetId}` | None | Returns generation status and, only on success, candidates |
| `POST /api/projects/{projectId}/generation-sets/{generationSetId}/retry` | `{ "idempotencyKey": UUID }` | Creates or returns the one allowed retry set after failure |

The client MUST send an `Idempotency-Key: UUID` header for brief upload
and confirmation, and an `idempotencyKey` body field for extraction retry,
generation creation, and generation retry. The server MUST store the key
with the operation and MUST reject reuse with a different input. The server
MUST reject a duplicate submit while the same operation is still pending
rather than starting a second operation.

The server creates one UUID `referenceId` at request ingress and returns
it only when an error occurs. It writes that same value to the server log.

### 3.3 Screen behavior and state handling

Each screen has these visible states:

- `idle`: editable controls are available when the screen preconditions hold;
- `submitting`, `uploading`, `extracting`, `queued`, or `running`: controls
  that would duplicate the operation are disabled;
- `retryableError`: the exact allowed retry action is shown;
- `terminalError`: the user sees the generic error and reference ID;
- `success`: the next screen or the persisted result is shown.

The transitions are exact:

1. `/projects/new` creates a project with no geometry. A blank name becomes
   `Untitled project`; a non-blank name is trimmed and validated.
2. `/geometry` cannot continue until width, depth, and at least one open
   side pass validation. Saving stores the server-normalized geometry and
   sets project status `geometry_ready`.
3. `/brief` accepts only one PDF when no asset exists. Successful validation
   stores the asset and sets project status `extracting`. If the
   existing asset has failed extraction, the screen offers only retry for
   that asset; it never accepts a replacement upload.
4. A valid extraction creates a draft, sets project status
   `brief_review`, and goes to `/brief/review`. A refusal, malformed
   structured response, timeout, or provider error leaves the asset intact,
   creates no draft, sets project status `brief_extraction_failed`,
   and shows `Retry extraction`.
5. `/brief/review` permits draft edits. `Confirm brief` is enabled only
   when the draft schema is valid and every critical unknown and every
   assumption marked `requiresConfirmation` is either resolved or explicitly
   accepted by the user.
6. Confirmation creates one immutable version, sets project status
   `brief_confirmed`, and routes to `/generate`. There is no
   edit-in-place path after confirmation in G2.
7. `/generate` permits one initial `Generate four concepts` submission.
   The server creates a generation set only after it verifies the geometry
   and confirmed brief version, and sets project status `generating`.
8. `/generations/{generationSetId}` polls or subscribes to the persisted
   set status. It shows candidates only when status is `succeeded` and the
   candidate count is exactly four. A failed set sets project status
   `generation_failed`; a successful set sets `concepts_ready`.

If a project is in a state that does not satisfy a route precondition, the
server returns `409` with a safe machine code and the UI routes back to the
earliest required screen. No state is inferred from client navigation.

## 4. Data contract

### 4.1 Shared types

~~~text
type UUID = string;       // UUID v4
type Timestamp = string;  // UTC RFC 3339, Z suffix
type Sha256 = string;     // lowercase 64-character SHA-256 hex
~~~

### 4.2 Project

~~~text
type ProjectStatus =
  | "draft"
  | "geometry_ready"
  | "extracting"
  | "brief_extraction_failed"
  | "brief_review"
  | "brief_confirmed"
  | "generating"
  | "generation_failed"
  | "concepts_ready";

type Project = {
  projectId: UUID;
  name: string;                         // 1-120 Unicode scalar values after trim
  status: ProjectStatus;
  boothGeometry: BoothGeometry | null;
  briefAssetId: UUID | null;
  briefDraftId: UUID | null;
  confirmedBriefVersionId: UUID | null;
  activeGenerationSetId: UUID | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
~~~

`Project` is the workflow pointer, not the source of truth for a confirmed
brief or candidate. The referenced immutable records are authoritative.

### 4.3 Booth geometry and open-side orientation

~~~text
type OpenSide = "north" | "east" | "south" | "west";

type BoothGeometry = {
  widthMm: integer;                     // 100-100000 inclusive
  depthMm: integer;                     // 100-100000 inclusive
  openSides: OpenSide[];                // 1-4 unique values, canonical order
  maxHeightMm: integer | null;          // null or 100-100000 inclusive
};
~~~

The canonical order for `openSides` is `north`, `east`, `south`,
`west`. Clients may submit any order, but the server MUST normalize to canonical
order before persistence and hashing.

The plan coordinate system is a rectangle with origin at the southwest
corner. Width runs west-east on the x axis. Depth runs south-north on the y
axis. `north` and `south` are the width edges; `east` and `west` are the
depth edges. The enum is the authoritative open-side orientation; there is
no free-text orientation field.

The UI displays and accepts metres to two decimal places. The exact
conversion is `millimetres = round(metres * 1000)`. The canonical server
payload is integer millimetres. A value that rounds outside the allowed
range is invalid. Width, depth, and open sides are hard user inputs and
MUST be present before a brief is uploaded or generation is allowed.

`maxHeightMm` is optional. `null` means no maximum height was supplied by
the user; it does not mean unlimited approved height and MUST NOT be
inferred from the brief. It is a prompt constraint only in this slice.

### 4.4 Uploaded brief asset

~~~text
type BriefAsset = {
  assetId: UUID;
  projectId: UUID;
  kind: "brief";
  originalFileName: string;              // sanitized basename, 1-120 chars
  mimeType: "application/pdf";
  byteSize: integer;                     // 1-20971520 inclusive
  pageCount: integer;                    // 1-20 inclusive
  storageKey: string;                    // projects/{projectId}/briefs/{assetId}.pdf
  sha256: Sha256;
  status: "stored";
  createdAt: Timestamp;
};
~~~

There is exactly one `BriefAsset` per project in G2. An invalid upload
creates no asset record and stores no bytes.

### 4.5 Structured brief draft and schema version

~~~text
type ProjectFacts = {
  clientName: string | null;             // null or 1-200
  eventName: string | null;              // null or 1-200
  venueName: string | null;              // null or 1-200
  eventLocation: string | null;          // null or 1-300
  eventStartDate: string | null;         // null or YYYY-MM-DD
  eventEndDate: string | null;           // null or YYYY-MM-DD
  notes: string | null;                  // null or 1-4000
};

type BrandStyle = {
  brandName: string | null;              // null or 1-200
  brandValues: string[];                 // max 20, each 1-200
  visualDirection: string | null;        // null or 1-2000
  preferredColors: string[];             // max 20, each 1-100
  materials: string[];                   // max 20, each 1-100
  logoInstructions: string | null;       // null or 1-1000
};

type FunctionalRequirement = {
  name: string;                          // 1-200
  count: integer | null;                 // null or 0-1000 inclusive
  countIsExact: boolean;                 // false when count is null
  mandatory: boolean;
  details: string | null;                // null or 1-2000
};

type Budget = {
  amount: number | null;                 // null or finite, >= 0
  currency: string | null;               // null or uppercase ISO-4217, 3 chars
  basis: "total" | "per_sqm" | "unknown" | null;
  notes: string | null;                  // null or 1-1000
};

type UnknownItem = {
  id: string;                            // stable slug, 1-80
  field: string;                         // 1-120
  question: string;                      // 1-1000
  critical: boolean;
  resolution: string | null;             // null or 1-2000
  acceptedByUser: boolean;
};

type AssumptionItem = {
  id: string;                            // stable slug, 1-80
  field: string;                         // 1-120
  value: string;                         // 1-2000
  source: "model" | "user";
  requiresConfirmation: boolean;
  acceptedByUser: boolean;
};

type ExtractedGeometryMentions = {
  widthText: string | null;              // null or 1-500
  depthText: string | null;              // null or 1-500
  openSidesText: string | null;          // null or 1-500
  maxHeightText: string | null;          // null or 1-500
};

type StructuredBriefData = {
  projectFacts: ProjectFacts;
  brandStyle: BrandStyle;
  functionalRequirements: FunctionalRequirement[]; // max 50
  mandatoryRequirements: string[];                  // max 50, each 1-1000
  prohibitedRequirements: string[];                // max 50, each 1-1000
  budget: Budget;
  unknowns: UnknownItem[];                           // max 50
  assumptions: AssumptionItem[];                    // max 50
  freeTextRequirements: string[];                    // max 50, each 1-2000
  extractedGeometryMentions: ExtractedGeometryMentions;
};

type StructuredBriefDraft = {
  briefDraftId: UUID;
  projectId: UUID;
  sourceAssetId: UUID;
  extractionRequestId: UUID;
  schemaVersion: "brief-v1";
  revision: positive integer;
  status: "extracted" | "edited";
  data: StructuredBriefData;
  providerMetadata: ProviderMetadata;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
~~~

The extraction JSON Schema MUST be strict: every object has
`additionalProperties: false`, every defined property is required, and
optional semantic values are represented as `null`. Arrays preserve
source-order or user-order as documented; the server does not sort their
contents.

`eventStartDate` and `eventEndDate` are either valid `YYYY-MM-DD` values or
`null`; an invalid date fails schema validation. `amount` is either `null`
or a finite non-negative number. `currency` is either `null` or an
uppercase three-letter ISO-4217 code. A functional requirement with
`count: null` MUST have `countIsExact: false`.

The model may populate `extractedGeometryMentions` as an informational
record of what the PDF said. These fields MUST NOT update
`Project.boothGeometry`, the geometry screen, the confirmed version, or any
generation input.

Unknowns and assumptions are first-class data. The extractor MUST preserve
material uncertainty in these arrays rather than silently inventing a
value. The model MUST set extracted assumptions to
`source: "model"` and `acceptedByUser: false`. A user edit may change an
assumption to `source: "user"` or set its acceptance flag.

### 4.6 Immutable structured brief version and user-confirmed brief

~~~text
type StructuredBriefVersion = {
  briefVersionId: UUID;
  projectId: UUID;
  sourceDraftId: UUID;
  sourceAssetId: UUID;
  versionNumber: positive integer;       // exactly 1 in G2
  schemaVersion: "brief-v1";
  status: "confirmed";
  geometrySnapshot: BoothGeometry;
  data: StructuredBriefData;
  contentHash: Sha256;
  confirmationMode: "explicit_user_action";
  confirmedAt: Timestamp;
  extractionProviderMetadata: ProviderMetadata;
};

type UserConfirmedBrief = {
  briefVersionId: UUID;
  projectId: UUID;
  versionNumber: 1;
  sourceAssetId: UUID;
  schemaVersion: "brief-v1";
  geometrySnapshot: BoothGeometry;
  data: StructuredBriefData;
  contentHash: Sha256;
  confirmedAt: Timestamp;
};
~~~

`UserConfirmedBrief` is a read-only API projection of the immutable
`StructuredBriefVersion`; it is not a second mutable source. The source of
truth for generation is the version's `data` plus its
`geometrySnapshot`. The `contentHash` covers the canonical JSON of
`schemaVersion`, `geometrySnapshot`, and `data`.

The server creates a version only after it verifies that all critical
unknowns have a non-null resolution or `acceptedByUser: true`, and that all
assumptions with `requiresConfirmation: true` have been resolved or
explicitly accepted. The version freezes the user-confirmed brief and the
user-supplied geometry together.

### 4.7 Provider and compiler metadata

~~~text
type ProviderMetadata = {
  provider: "openai";
  api: "responses" | "images";
  model: "gpt-5.4-mini" | "gpt-image-2";
  modelSnapshot:
    | "gpt-5.4-mini-2026-03-17"
    | "gpt-image-2-2026-04-21";
  providerRequestId: string | null;
  inputTokens: integer | null;
  outputTokens: integer | null;
  totalTokens: integer | null;
  receivedAt: Timestamp;
};

type CompilerMetadata = {
  compilerVersion: "g2-booth-v1";
  directionKey:
    | "modular-clarity"
    | "brand-theatre"
    | "open-demo"
    | "hospitality-consultation";
  canonicalInputHash: Sha256;
  promptHash: Sha256;
  compiledAt: Timestamp;
};
~~~

The valid provider combinations are exact: `responses` with
`gpt-5.4-mini` and snapshot `gpt-5.4-mini-2026-03-17` for extraction;
`images` with `gpt-image-2` and snapshot
`gpt-image-2-2026-04-21` for image generation. Provider request IDs and
usage are metadata only. They MUST NOT be used as source content or exposed
in user-facing error text.

### 4.8 Generation request and generation set

~~~text
type GenerationRequest = {
  generationRequestId: UUID;
  projectId: UUID;
  confirmedBriefVersionId: UUID;
  generationSetId: UUID;
  idempotencyKey: UUID;
  inputHash: Sha256;
  requestedCandidateCount: 4;
  attempt: 1 | 2;
  status: "accepted" | "running" | "succeeded" | "failed";
  requestReferenceId: UUID;
  failureCode: string | null;
  createdAt: Timestamp;
  completedAt: Timestamp | null;
};

type GenerationSet = {
  generationSetId: UUID;
  projectId: UUID;
  confirmedBriefVersionId: UUID;
  generationRequestId: UUID;
  attempt: 1 | 2;
  retryOfGenerationSetId: UUID | null;
  status: "queued" | "running" | "succeeded" | "failed";
  expectedCandidateCount: 4;
  promptCompilerVersion: "g2-booth-v1";
  promptManifestHash: Sha256;
  provider: "openai";
  imageModelSnapshot: "gpt-image-2-2026-04-21";
  createdAt: Timestamp;
  completedAt: Timestamp | null;
  failureCode: string | null;
};
~~~

`inputHash` covers the canonical compiler input, compiler version,
provider model snapshot, and fixed direction list.
`promptManifestHash` covers the ordered four prompt hashes.

### 4.9 Immutable concept assets and candidates

~~~text
type ConceptAsset = {
  assetId: UUID;
  projectId: UUID;
  generationSetId: UUID;
  storageKey: string;                    // projects/{projectId}/concepts/{candidateId}.png
  mimeType: "image/png";
  byteSize: positive integer;
  sha256: Sha256;
  status: "stored";
  createdAt: Timestamp;
};

type CandidateDirection =
  | "modular-clarity"
  | "brand-theatre"
  | "open-demo"
  | "hospitality-consultation";

type ConceptCandidate = {
  candidateId: UUID;
  generationSetId: UUID;
  projectId: UUID;
  confirmedBriefVersionId: UUID;
  candidateIndex: 1 | 2 | 3 | 4;
  directionKey: CandidateDirection;
  assetId: UUID;
  compilerMetadata: CompilerMetadata;
  providerMetadata: ProviderMetadata;
  createdAt: Timestamp;
};
~~~

Candidate index and direction are a fixed one-to-one mapping:

| Candidate index | Direction key | Direction intent |
| ---: | --- | --- |
| 1 | `modular-clarity` | Clear modular composition, legible circulation, and disciplined hierarchy |
| 2 | `brand-theatre` | Strong focal brand expression with plausible supporting functions |
| 3 | `open-demo` | Outward-facing demonstration and approachable visitor access |
| 4 | `hospitality-consultation` | Welcoming reception and consultation balance with calm seating logic |

All four candidates MUST share the same hard constraints, geometry, brief
version, compiler version, camera intent, and prohibitions. Only the
direction block varies.

Candidate records and their PNG assets are immutable. There is no
`selected`, `qaStatus`, `repairOf`, `refinementOf`, or editing field in the
G2 candidate contract.

## 5. Booth geometry contract

The geometry screen is mandatory. Width and depth MUST be supplied by the
user; open-side selection MUST contain an explicit side; max height is
optional.

Validation is server-side and repeated on every operation that depends on
geometry:

- width and depth are finite integers from 100 mm through 100000 mm,
  inclusive;
- width and depth are not zero, negative, missing, or inferred;
- `openSides` contains one through four distinct enum values;
- `openSides` is normalized to the canonical north/east/south/west order;
- `maxHeightMm` is null or an integer from 100 mm through 100000 mm,
  inclusive;
- no value may be supplied in centimetres, inches, feet, or a free-text
  unit field;
- a client-submitted `boothGeometry` in a brief or generation request is
  ignored for authority and is rejected if it conflicts with the server
  snapshot.

Missing or invalid geometry blocks the geometry screen's Continue action,
prevents brief upload, and makes confirm/generation return `409`
`GEOMETRY_REQUIRED` or `GEOMETRY_INVALID`. The extractor cannot
repair, replace, or override it. A geometry edit is allowed only before
brief confirmation. After confirmation, the snapshot is frozen; a material
geometry change is not available after confirmation in G2. A future material
geometry change MUST create a new immutable brief version and MUST NOT mutate
this version.

## 6. Upload contract

The smallest supported first-brief input is one PDF:

- exactly one multipart part named `file`;
- MIME type `application/pdf`;
- `.pdf` filename extension after trimming;
- valid PDF signature and parseable page tree;
- one through 20 pages inclusive;
- one byte through 20 MiB inclusive (`20 * 1024 * 1024`);
- no password-protected or encrypted PDF;
- no images, DOCX, PPTX, XLSX, standalone logos, reference images, or
  second brief in G2.

The server MUST validate the file bytes, not only the browser MIME header or
filename. It MUST reject extension/MIME/signature mismatch, empty files,
oversized files, over-page-limit files, malformed PDFs, and encrypted PDFs
with safe field-level errors. Rejected files MUST NOT be persisted.

The server assigns the asset ID and stores the accepted bytes under the
private object key:

`projects/{projectId}/briefs/{assetId}.pdf`

The original filename is stored only as a sanitized basename with control
characters and path separators removed. It MUST NOT influence the storage
path. The object is private and is never served through a public bucket
URL. Extraction retries reuse the same asset and SHA-256; they do not
create a second asset.

The contract requires a server-side base64 `input_file` request and does
not depend on provider-side file lifecycle state. Provider upload limits do
not relax the application limits above.

## 7. Single-provider decision

The only provider in v0.1 G2 is OpenAI. G3 MUST NOT add a provider
interface, fallback provider, routing table, or multi-provider configuration
for this slice. The provider API key is read only on the server from the
environment variable name `OPENAI_API_KEY`; no key value may appear in the
repository, browser bundle, logs, tests, fixtures, or PR evidence.

### 7.1 Extraction

Use the OpenAI Responses API with the pinned model snapshot
`gpt-5.4-mini-2026-03-17`.

The adapter MUST submit one PDF as an `input_file` with:

- `filename: "brief.pdf"` (the real filename is not sent as a prompt
  instruction);
- `file_data` containing a server-created
  `data:application/pdf;base64,...` value;
- `detail: "high"`;
- no tools;
- `store: false`;
- structured output using the strict `brief-v1` JSON Schema in section 4.5.

The adapter MUST treat refusal, incomplete output, invalid JSON, schema
failure, timeout, rate limit, and provider 4xx/5xx responses as extraction
failure. It MUST NOT fabricate missing fields or silently use extracted
geometry in place of user geometry.

The initial extraction and the one allowed user-triggered extraction retry
are the only extraction attempts for an asset. A second extraction failure
is terminal for the project in G2; it does not permit a replacement asset.

### 7.2 Concept image generation

Use the OpenAI Images API with pinned model snapshot
`gpt-image-2-2026-04-21`.

For each of the four fixed directions, the adapter submits exactly one
request with:

- `n: 1`;
- `size: "1536x1024"`;
- `quality: "medium"`;
- the compiled prompt for that direction;
- no image input, image edit, mask, or reference-image parameter.

The expected provider result is one base64 PNG. The server validates the
decoded non-empty PNG, stores it privately, computes SHA-256, and records
the provider and compiler metadata. A missing, malformed, or empty image
is a candidate failure.

### 7.3 Inspected official primary sources

These official OpenAI sources were inspected on 2026-08-25:

- [GPT-5.4 mini model documentation](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
  - confirms Responses API support, image input, and structured outputs;
  - identifies snapshot `gpt-5.4-mini-2026-03-17`.
- [File inputs guide](https://developers.openai.com/api/docs/guides/file-inputs)
  - documents PDF `input_file` handling, base64/file ID/URL inputs, and
    PDF text plus page-image processing on vision-capable models.
- [Structured outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs)
  - documents strict JSON Schema output and
    `additionalProperties: false`.
- [Responses API create reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
  - documents file input and structured response configuration.
- [GPT-image-2 model documentation](https://developers.openai.com/api/docs/models/gpt-image-2)
  - confirms image input/output, Images API support, and snapshot
    `gpt-image-2-2026-04-21`.
- [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
  - documents choosing the Image API for a single image, `n`, supported
    size/quality options, PNG output defaults, and generation latency.

## 8. Structured extraction and confirmation

### 8.1 Extraction result

The model returns exactly `StructuredBriefData` under the strict
`brief-v1` schema. It must capture project/event facts where present,
brand/style, functional requirements and counts, mandatory requirements,
prohibited requirements, budget where present, unknowns, assumptions,
free-text requirements, and informational geometry mentions.

The model MUST use `null` or an empty array when the source does not
provide a value. It MUST place unresolved material questions in
`unknowns`. It MUST NOT guess booth width, depth, open sides, or max height
as canonical project values.

An extraction draft starts at `revision: 1` and `status: "extracted"`.
Each accepted draft edit requires the full `StructuredBriefData` plus the
current `expectedRevision`; the server validates it and increments
`revision` by one. A stale `expectedRevision` returns
`409 DRAFT_REVISION_CONFLICT` and does not overwrite the newer draft.

### 8.2 What the user may edit

Before confirmation, the user may edit all `StructuredBriefData` fields,
including adding, deleting, or changing functional requirements, mandatory
and prohibited requirements, budget, unknown resolutions, assumptions, and
brand/style text. The user cannot edit the source asset, the schema version,
provider metadata, extraction request ID, or canonical geometry on the
review screen.

The UI MUST show the server geometry separately from extracted geometry
mentions. If the PDF mentions different dimensions, the user may record
that discrepancy in an unknown or note, but the server geometry remains
authoritative.

### 8.3 Confirmation

`POST /api/projects/{projectId}/brief/confirm` freezes:

- the complete validated `StructuredBriefData`;
- the server canonical `BoothGeometry`;
- the source asset ID;
- `schemaVersion: "brief-v1"`;
- `versionNumber: 1`;
- the content hash;
- the explicit user confirmation timestamp.

The server creates exactly one confirmed version for the current draft.
Confirmation is allowed only once in G2. A confirmed version cannot be
edited or deleted. A material change after confirmation, including any
geometry, functional, mandatory, prohibited, brand, budget, unknown
resolution, or assumption change, MUST create a new immutable brief version;
G2 exposes no post-confirmation edit route and has no in-place revision
behavior.

Generation is allowed only when `Project.confirmedBriefVersionId` points
to a confirmed version and that version's geometry snapshot passes server
validation.

## 9. Deterministic prompt compiler

### 9.1 Compiler inputs

The compiler accepts exactly:

1. the immutable `UserConfirmedBrief`;
2. `compilerVersion: "g2-booth-v1"`;
3. one fixed `directionKey`;
4. fixed camera intent
   `landscape 3/4 eye-level exhibition-booth hero`;
5. the static hard-constraint and visual-plausibility rules below.

The compiler input hash covers the confirmed schema version, geometry
snapshot, all confirmed brief data except the non-authoritative
`extractedGeometryMentions`, compiler version, provider model snapshot,
and fixed direction list. The non-authoritative geometry mentions are not
rendered or hashed into a prompt.

The compiler does not accept client-authored prompt text, a random seed, a
timestamp, provider choice, a second geometry, a QA result, or an
image/mask.

The static hard constraint text is exactly:

`Fit the booth inside the confirmed width and depth; keep every open side visibly open and accessible; respect max height when supplied; use plausible circulation, readable scale, stable-looking elements, realistic support, and coherent materials; this is visual screening only and is not engineering, fabrication, structural, fire, accessibility, code, or venue approval.`

### 9.2 Canonical input and exact prompt template

Canonical JSON uses RFC 8785 JSON Canonicalization Scheme semantics: UTF-8,
object keys sorted by Unicode code point, arrays preserved in their defined
order, JSON string escaping, no insignificant whitespace, and canonical
JSON numbers. Let `JCS(value)` mean that serialization.

Every prompt is the following exact array of lines joined with one LF
character and has no final LF. Values after `=` are either JCS values or
the exact quoted literal shown:

~~~text
[
  "[CONTEXT]",
  "schemaVersion=" + JCS(confirmed.schemaVersion),
  "projectFacts=" + JCS(confirmed.data.projectFacts),
  "[HARD_GEOMETRY]",
  "widthMm=" + decimal(confirmed.geometrySnapshot.widthMm),
  "depthMm=" + decimal(confirmed.geometrySnapshot.depthMm),
  "openSides=" + JCS(confirmed.geometrySnapshot.openSides),
  "maxHeightMm=" + JCS(confirmed.geometrySnapshot.maxHeightMm),
  "hardConstraintText=" + quote(EXACT_HARD_CONSTRAINT_TEXT),
  "[FUNCTIONAL_REQUIREMENTS]",
  "functionalRequirements=" + JCS(confirmed.data.functionalRequirements),
  "mandatoryRequirements=" + JCS(confirmed.data.mandatoryRequirements),
  "budget=" + JCS(confirmed.data.budget),
  "freeTextRequirements=" + JCS(confirmed.data.freeTextRequirements),
  "[BRAND_STYLE]",
  "brandStyle=" + JCS(confirmed.data.brandStyle),
  "[CREATIVE_DIRECTION]",
  "directionKey=" + quote(directionKey),
  "directionInstruction=" + quote(EXACT_DIRECTION_INSTRUCTION[directionKey]),
  "[PRESENTATION_INTENT]",
  "cameraIntent=" + quote("landscape 3/4 eye-level exhibition-booth hero"),
  "[PROHIBITIONS_AND_UNKNOWN_HANDLING]",
  "prohibitedRequirements=" + JCS(confirmed.data.prohibitedRequirements),
  "unknowns=" + JCS(confirmed.data.unknowns),
  "assumptions=" + JCS(confirmed.data.assumptions),
  "buildabilityBoundary=" + quote("Visual screening only; no engineering, fabrication, structural, fire, accessibility, code, or venue approval."),
  "[OUTPUT_INSTRUCTION]",
  "outputInstruction=" + quote("Create one landscape exhibition-booth concept image; do not add a second view, plan, technical drawing, dimensions, certification, or approval claim.")
]
~~~

`decimal` is the canonical base-10 representation of a validated integer
with no leading zero except zero. `quote` is JSON string quoting. The
literal names, line order, section headers, and punctuation above are
normative. The compiler MUST NOT add or omit a line.

The exact direction instructions are:

- `modular-clarity`:
  `Explore a clean modular composition with a legible hierarchy, disciplined circulation, and repeatable-looking components.`
- `brand-theatre`:
  `Explore a strong focal brand moment with memorable vertical or overhead emphasis while keeping support functions plausible.`
- `open-demo`:
  `Explore an outward-facing demonstration layout that makes visitor access, activity, and product interaction immediately readable.`
- `hospitality-consultation`:
  `Explore a welcoming reception and consultation composition with calm seating logic and an approachable human scale.`

The hard geometry, functional requirements, brand/style, presentation,
prohibitions, and output sections are identical for all four candidates.
Only `directionKey` and `directionInstruction` vary. User and
extracted strings are inside JSON-quoted reference data and are explicitly
treated as content, not instructions. The compiler MUST NOT let brief text
override the hard-constraint text or provider safety controls.

### 9.3 Compiler output and persistence

~~~text
type CompiledPromptRecord = {
  compiledPromptId: UUID;
  generationSetId: UUID;
  candidateIndex: 1 | 2 | 3 | 4;
  directionKey: CandidateDirection;
  compilerMetadata: CompilerMetadata;
  promptText: string;
  createdAt: Timestamp;
};
~~~

The server persists every compiled prompt in a private database record
before its image request. It persists the exact prompt hash and the
ordered `promptManifestHash` on the generation set. Prompt text is never
returned to the client in G2 and is never logged.

The same canonical inputs, compiler version, and direction MUST produce the
same prompt text and prompt hash. A compiler code change requires a new
compiler version and is outside this locked G2 implementation.

## 10. Four-candidate semantics

An initial generation set always means exactly four candidates, one for
each fixed direction. G3 MUST start the four independent provider calls as
one bounded batch with a maximum concurrency of four. Completion order does
not change candidate index. It MUST use `n: 1` per request so each provider
result maps to exactly one candidate index.

The set is successful only if all four requests return one valid PNG and
all four assets are durably stored. Fewer than four successes is failure;
there is no partial success state, no automatic repair, no QA, and no
sample, placeholder, or fake fallback.

Provider requests are user-visible as `queued` or `running`; their
individual prompts and outputs are not exposed in progress errors. A
provider timeout, refusal, empty result, malformed image, rate limit, or
4xx/5xx marks the set failed with a stored safe failure code and request
reference. The application does not silently retry a provider request.

## 11. Persistence, idempotency, and retries

### 11.1 Immutable persistence

The server MUST persist in this order:

1. project;
2. validated geometry;
3. one private brief asset;
4. extraction draft;
5. immutable confirmed brief version;
6. generation request and generation set;
7. four compiled prompt records;
8. four private PNG assets and candidate records;
9. successful generation-set status.

The four candidate records MUST be committed as one logical success. A
client MUST never observe `succeeded` with fewer than four candidates.
Candidate records and assets cannot be updated or overwritten. A new
generation set is the only way to produce a later set, but G2 permits only
one initial set and one user-triggered retry for a failed set.

### 11.2 Idempotency

The client generates a UUID idempotency key per brief upload, extraction
retry, confirmation, generation creation, and generation retry. It reuses
that key when retrying the same request after an uncertain network
response. The server stores the key, operation, project ID, confirmed
version ID where applicable, canonical input hash, and result reference.

- Same key and same input hash returns the original result and does not
  call the provider again.
- Same key with a different project, confirmed version, compiler version,
  asset, or input hash returns `409 IDEMPOTENCY_KEY_REUSE`.
- A duplicate initial submit after a successful set returns the existing
  successful set and does not create a second set.
- A duplicate initial submit while the set is queued or running returns
  the existing pending set.
- A failed initial set may be retried exactly once through the retry
  endpoint. The retry gets a new generation-set ID and new idempotency key,
  records `retryOfGenerationSetId`, and reruns all four directions.
- A second retry, or retry of a successful set, returns `409
  RETRY_NOT_ALLOWED`.

For a brief upload, the same key and same file SHA-256 returns the original
asset/extraction operation without creating another asset. A different
file with the same key returns `409 IDEMPOTENCY_KEY_REUSE`. For
extraction retry, the same key and same asset returns the original
extraction result or pending operation.

### 11.3 Partial provider failure

Image results are first staged under a private attempt prefix. If any one
of the four calls fails, the generation set becomes `failed`, no
`ConceptCandidate` is published, and successful staged results are not
represented as user-visible candidates. The server MUST attempt to delete
all staged bytes for that failed attempt. If cleanup itself fails, the
failure remains private and non-user-visible, and the set is still failed;
cleanup failure MUST NOT publish a candidate.

The retry is a new set and reruns all four directions. It does not mix
results from two attempts. A second failed attempt is terminal for this
confirmed version in G2. There is no fake-success state.

## 12. Error, privacy, and logging contract

Every server request creates or propagates one UUID `referenceId`. The
server log entry for that request contains the same ID and may contain:

- operation name;
- safe machine error code;
- HTTP status;
- project, asset, version, request, or generation-set IDs;
- provider name and model snapshot;
- elapsed time;
- provider request ID and usage metadata, if available.

The server MUST NOT log or persist in logs:

- PDF contents, extracted brief contents, or filenames beyond safe
  metadata;
- compiled prompts;
- generated image bytes, image content, or image URLs;
- API keys, secrets, authorization headers, cookies, or signed URLs;
- unnecessary personal or customer information;
- stack traces in user-facing responses.

Private database and object storage records may contain the source asset,
confirmed brief, compiled prompt, and generated candidates because they are
required source artifacts, but they MUST remain behind the existing private
application and storage boundary. Public-repository files contain only
schema, contract, and environment variable names; no secret or credential
value is permitted.

User-facing errors are generic and traceable. Provider errors are mapped to
safe codes such as `EXTRACTION_FAILED`, `IMAGE_GENERATION_FAILED`,
`GENERATION_TIMEOUT`, or `PERSISTENCE_FAILED`; the raw provider message is
not returned. No error path produces a success response without the
corresponding persisted record.

## 13. Minimum G3 tests and acceptance criteria

G3 MUST implement automated tests for at least the following cases.

### Geometry

- width and depth lower/upper bounds, missing values, zero, negative,
  non-integer, and unit conversion;
- max height null and valid/invalid bounds;
- one, four, duplicate, and invalid open sides;
- canonical open-side ordering;
- missing or invalid geometry blocks upload, confirmation, and generation;
- extracted geometry mentions never overwrite user geometry;
- confirmed geometry snapshot exactly equals the saved user geometry.

### Upload

- valid one-page and 20-page PDFs are accepted;
- non-PDF, extension/MIME mismatch, invalid signature, empty, malformed,
  encrypted, over-20-MiB, and over-20-page files are rejected;
- rejected bytes create no asset record;
- one asset per project is enforced;
- storage key is server-generated and private;
- source filename path traversal and control characters cannot affect the
  storage key.

### Extraction and schema

- strict `brief-v1` output accepts the complete schema;
- missing required property, extra property, invalid date, invalid
  currency, invalid count, invalid array item, malformed JSON, provider
  refusal, and incomplete provider response fail safely;
- project/event facts, brand/style, functional counts, mandatory and
  prohibited requirements, budget, unknowns, assumptions, and geometry
  mentions are preserved;
- unknown fields from provider output are rejected by strict schema rather
  than silently dropped;
- unknowns and assumptions remain visible and editable.

### Confirmation and versioning

- draft edits require the expected revision and increment it;
- stale draft revision cannot overwrite newer data;
- critical unknowns and required assumptions block confirmation until
  resolved or explicitly accepted;
- confirmation creates version 1 with the exact geometry snapshot and hash;
- the confirmed version is immutable;
- generation is blocked before confirmation;
- post-confirmation material edits are rejected and do not mutate the
  version.

### Prompt compilation

- identical canonical inputs produce byte-identical prompts and hashes;
- changing only the direction key changes only the direction key and
  direction instruction lines;
- all four prompts share identical hard-constraint blocks and exact line
  order;
- prompt manifest order is fixed;
- compiler version and hashes persist;
- prompts contain no engineering, fabrication, venue, or approval claim.

### Four-candidate persistence

- exactly four image calls are made for a clean initial generation;
- each fixed direction maps to the correct index;
- a successful set persists exactly four immutable PNG candidates and
  concept assets;
- candidates reference the confirmed brief version and compiler metadata;
- no QA, automatic repair, selection, refinement, mask, or fake fallback
  fields or behavior is invoked.

### Idempotency, partial failure, and retry

- duplicate submit with the same key and input returns the same result
  without new provider calls;
- same key with different input returns `409`;
- duplicate submit while pending does not fork a set;
- one provider timeout, refusal, empty result, malformed image, or failure
  makes the whole set fail and exposes no candidates;
- successful partial results are not mixed into a retry;
- one retry creates a new set and reruns all four directions;
- a second retry is rejected;
- no provider failure produces fake success or sample output.

### Provider and privacy

- extraction uses OpenAI Responses with the pinned extraction snapshot,
  PDF input, `store: false`, and strict structured output;
- image generation uses OpenAI Images with the pinned image snapshot,
  `n: 1`, `1536x1024`, and medium quality;
- no provider key is present in client code, test output, fixtures, or
  repository files; only the environment variable name is referenced;
- user-facing errors contain a generic message and reference ID;
- the same reference ID is present in server logs;
- logs contain no uploaded content, prompts, generated output, secrets,
  auth headers/cookies, or unnecessary PII.

### Slice acceptance flow

An isolated acceptance test MUST prove:

create project -> save valid geometry -> upload one valid PDF -> receive a
valid structured draft -> edit and confirm it -> compile four deterministic
prompts -> generate four provider-backed PNGs -> persist and retrieve
exactly four immutable candidates.

The acceptance test MUST also cover the invalid and retry paths above.
It MUST stop at persisted candidates and MUST NOT implement or call any
later MVP surface.

## 14. Exact G3 boundary

G3 is authorized to implement only:

1. the six routes and screen states in section 3;
2. the listed API operations and exact request bodies;
3. persistence for the exact records and private assets in section 4;
4. the geometry and PDF validation rules;
5. the OpenAI extraction and image adapters with the pinned models and
   request shapes;
6. the deterministic `g2-booth-v1` compiler;
7. the idempotency, retry, generic error, privacy, and logging behavior;
8. the minimum automated tests and acceptance flow in section 13.

G3 MUST NOT decide new fields, alter limits, infer geometry, add provider
routing, add QA or repair, add later product screens, expose provider
credentials, or broaden the upload set. Any behavior not required by this
contract is out of scope for the G2 slice and requires a new decision lock
or an explicit G1/G2 amendment.
