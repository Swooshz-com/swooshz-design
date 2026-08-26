# S2 G3 fresh-lineage completion audit

Date: 2026-08-26
Final repair validation update: 2026-08-27

Repository: `Swooshz-com/swooshz-design`

Branch: `web/run-007-s2-g3-nonconvergence-reset`

Audit scope: the authorized fresh S2 G3 implementation under `DL-SD-S2-G1-001`,
`DL-SD-S2-G2-003`, and `DL-SD-S2-G3-001`, from canonical base
`68fbbb8653733554730d90316ce6e91719f1ffce`. No deployment, live-system,
credential, customer-data, or provider action was in scope.

## Instruction and requirements reviewed

- Root `AGENTS.md` and repository portable playbook index.
- Repository README and architecture/source-boundary documents.
- `docs/G2_S2_CONTRACT.md`, including the revised Section 24 and MEDIA-012
  clarification.
- `docs/G2_FIRST_SLICE_CONTRACT.md` and applicable repository validation
  guidance.
- The authorized user packet and its explicit standard-security/browser
  disposition.

## Validation executed

| Check | Result | Evidence |
| --- | --- | --- |
| Claim-aware Section-24 suite | PASS, 17/17 tests | 103 base rows, 329 derived claims; missing 0, unknown 0, duplicate 0, skipped 0 |
| Evidence validator negative self-tests | PASS, 13/13 intentional failure cases | Missing, unknown, duplicate, absent variant, sequential concurrency, boundary mismatch, missing/unlinked provenance, unbound assertion, impossible MEDIA-014 aggregate, grouped partial success, missing claim-specific assertion, and false-fact-not-proof all failed for the intended reason |
| Complete S1 regression | PASS, 41/41 tests | `tests/g3.test.ts` |
| Typecheck | PASS | `pnpm run typecheck` |
| Configured lint | PASS | `pnpm run lint` (repository-configured TypeScript lint) |
| Production build | PASS | `pnpm run build`; Next.js 16.3.2/Turbopack routes generated |
| Native sharp/runtime | PASS | sharp 0.35.3, libvips 8.18.3, native binding and deterministic normalized hash |
| Dependency/lockfile | PASS | offline frozen-lockfile install and `pnpm list --depth=0` |
| `git diff --check` | PASS | no whitespace errors |
| Markdown fences | PASS | all tracked Markdown fence counts balanced |
| Temporary-marker scan | PASS | zero unintentional temporary markers; the evidence validator uses a controlled reject-list sentinel |
| Changed-content secret scan | PASS | zero private-key/token/API-key/credential-pattern matches |
| Client credential/bundle boundary | PASS | zero provider URL, authorization, env, private-path, prompt, or payload matches in S2 client files |
| Privacy/logging review | PASS in scope | one server log site emits only reference ID, operation, status, and safe code; zero sensitive-log matches |
| Standard manual/static security review | PASS in scope | S2 API, upload/media, private-object, provider-adapter, client-bundle, persistence/fencing, and error/logging paths reviewed; no known unresolved P0/P1 blocker |
| Live provider calls | PASS | zero; tests use local mock providers/fake fetch only |

## Evidence architecture

`tests/s2-evidence-manifest.ts` derives the current Section-24 manifest from
the canonical G2-003 contract. It has 103 base rows and 329 explicit claims;
G2-003 removes the impossible MEDIA-014 aggregate variants and the impossible
BIND-009 exact-128-MiB decoded variant. Every record carries the
contract-required test ID, claim/variant ID, fixture/setup, expected result,
actual result, safe local reference ID, and artifact/test-output provenance.

The final evidence-integrity repair changes the collector from the unsafe
grouped `proveMany(claimIds, proof, oneCallback)` shape to
`proveClaim(claimId, proof, assertion)` plus
`proveMany([{ claimId, proof, assertion }, ...])`. The matrix wrapper requires
a distinct assertion callback for every claim in a grouped emission and calls
each callback before that claim is emitted. If one grouped assertion fails,
only claims whose own preceding assertions succeeded can exist in the
registry. The emitted actual text and observation facts remain bound to the
proving fixture, and final completeness compares emitted claim IDs with the
canonical manifest. There is no manifest-wide behavioral record synthesis and
no `actualForClaim()` fallback. A source audit enumerated 112 proof calls: 22
single-claim calls and 90 multi-claim calls; all 90 multi-claim calls supplied
explicit per-claim assertion maps, with zero grouped calls missing a map.
Completeness rejects missing, unknown, duplicate, empty, weak source-token,
wrong-boundary, unbound-assertion, and non-concurrent evidence.

The fresh suite includes genuine local behavioral fixtures for the known weak
rows: distinct MEDIA-008 truncated, corrupt, warning-only, and multi-frame
rejection classes; the revised MEDIA-012 exact square and MEDIA-011 first
representable over-dimension boundary; real MEDIA-013 bind aggregates; real
MEDIA-015 normalization output; DRAFT-003 reorder; G2-003 MEDIA-014 and
BIND-009 maximum-representable aggregate boundaries; all six QA-012 failure
classes; RETRY-005 late-attempt races; production repair-adapter bad-output
classes; publication owner recovery; active-phase restart; and stale
repair/re-QA fencing.

BIND-002 re-read all four persisted private S1 source objects and independently
matched candidate IDs, indexes `[1,2,3,4]`, ConceptAsset IDs, byte lengths,
SHA-256 identities, decoder-derived dimensions, pixel counts, and
pixel-count-times-four RGBA values to the bound snapshots. BIND-004 rebuilt
the canonical input, requirement, and binding objects from persisted immutable
inputs, then independently recomputed `inputHash`, `requirementHash`, and
`bindingHash` with `jcs()` and `sha256()`; all three matched the persisted
hashes. BIND-009 summed actual persisted source and selected-normalized bytes
and measured the real bind at exactly 33,554,432 encoded bytes, 32,000,000
decoded pixels, and 128,000,000 decoded RGBA-equivalent bytes while retaining
the independently configured 134,217,728-byte defence-in-depth guard; no
impossible 134,217,728-byte decoded fixture was used.

## Browser/UI verification

The production-built Next.js app was started on loopback only with
`pnpm exec next start --hostname 127.0.0.1 --port 3101`; readiness and the
startup log were verified for the run-owned server. Playwright CLI snapshots
verified:

- `/projects/new` renders the local project creation surface.
- The production-built `/projects/new` response is HTTP 200 and renders the
  project-name field and Create project control.
- An unknown synthetic S2 QA route returns the expected 404.
- The browser request inventory contains loopback-only URLs; no provider or
  external URL was contacted.

Fresh snapshot artifacts: `.playwright-cli/page-2026-08-26T17-20-32-870Z.yml`
and `.playwright-cli/page-2026-08-26T17-20-55-369Z.yml`.

The repository Playwright wrapper could not run because WSL has no
`/bin/bash`; the wrapper's documented direct `npx --package @playwright/cli`
command was used instead. A full browser click-through of a persisted completed
QA run was not performed: clicking Run S2 QA in the production local app would
use the real adapter, while the authorized disposition requires zero live
provider calls. The complete deterministic local client/API and workflow tests
cover those persisted states without that call.

## Security-readiness disposition

Codex Security was not available in the installed capabilities and was not
invoked. The user explicitly marked deep security as not required and stated
that its absence is not a blocker; no substitute deep external product was
used. Standard manual/static review, targeted security tests, changed-content
secret scanning, client-boundary review, privacy/logging review, private
storage/path review, and failure-injection tests were performed.

No known unresolved P0/P1 security blocker was found in the declared scope.
Security coverage is limited to the declared scan scope and validation evidence;
this report does not claim perfect security or production clearance.

| Severity | Finding | Disposition |
| --- | --- | --- |
| P0 | None found in scope | Closed for this audit |
| P1 | None found in scope | Closed for this audit |
| P2 | Deep/Codex Security scan unavailable/not required | Recorded limitation; standard manual/static review completed |
| P2 | Full browser completed-run flow not exercised without a live provider | Recorded limitation; deterministic local workflow/client coverage passed |

## Release gates and remaining checks

The implementation is ready for the authorized Web exact-head review only after
the final GitHub publication checks in the controlling packet. GitHub CI/checks
must be reported from actual attached statuses; this local audit does not claim
CI. G4, Ready, merge, deployment, S3, and live activation remain unauthorized.

No customer/private material was used. No credentials were used. No live
provider calls were made. No repository memory file was required by this audit.
