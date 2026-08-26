# S2 G3 fresh-lineage completion audit

Date: 2026-08-26

Repository: `Swooshz-com/swooshz-design`

Branch: `web/run-007-s2-g3-nonconvergence-reset`

Audit scope: the authorized fresh S2 G3 implementation under `DL-SD-S2-G1-001`,
`DL-SD-S2-G2-002`, and `DL-SD-S2-G3-001`, from canonical base
`3d5aca89a698f05fbb51c5f980d2578b5f44b007`. No deployment, live-system,
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
| Claim-aware Section-24 suite | PASS, 16/16 tests | 103 base rows, 330 derived claims; missing 0, unknown 0, duplicate 0, skipped 0 |
| Complete S1 regression | PASS, 41/41 tests | `tests/g3.test.ts` |
| Typecheck | PASS | `pnpm run typecheck` |
| Configured lint | PASS | `pnpm run lint` (repository-configured TypeScript lint) |
| Production build | PASS | `pnpm run build`; Next.js 16.3.2/Turbopack routes generated |
| Native sharp/runtime | PASS | sharp 0.35.3, libvips 8.18.3, deterministic normalized hash |
| Dependency/lockfile | PASS | offline frozen-lockfile install and `pnpm list --depth=0` |
| `git diff --check` | PASS | no whitespace errors |
| Markdown fences | PASS | all tracked Markdown fence counts balanced |
| Temporary-marker scan | PASS | zero unintentional temporary markers; the evidence validator uses a controlled reject-list sentinel |
| Changed-content secret scan | PASS | zero private-key/token/API-key/credential-pattern matches |
| Client credential/bundle boundary | PASS | zero provider URL, authorization, env, private-path, prompt, or payload matches in S2 client files |
| Privacy/logging review | PASS in scope | one server log site emits only reference ID, operation, status, and safe code; zero sensitive-log matches |
| Live provider calls | PASS | zero; tests use local mock providers/fake fetch only |

## Evidence architecture

`tests/s2-evidence-manifest.ts` derives the current Section-24 manifest from
the revised contract. Every record carries the contract-required test ID,
claim/variant ID, fixture/setup, expected result, actual result, safe local
reference ID, and artifact/test-output provenance. Completeness rejects missing,
unknown, duplicate, empty, weak source-token, and non-concurrent evidence.

The fresh suite includes genuine local behavioral fixtures for the known weak
rows: distinct MEDIA-008 rejection classes; the revised MEDIA-012 exact square
and MEDIA-011 first representable over-dimension boundary; real MEDIA-013 bind
aggregates; real MEDIA-015 normalization output; DRAFT-003 reorder; BIND-009
persisted aggregate boundaries; all six QA-012 failure classes; RETRY-005
late-attempt races; production repair-adapter bad-output classes; publication
owner recovery; active-phase restart; and stale repair/re-QA fencing.

## Browser/UI verification

The local Next.js app was started on loopback only with a temporary synthetic
data root. Playwright CLI snapshots verified:

- `/projects/new` renders the local project creation surface.
- The seeded S2 references screen renders the visual-only disclosure, editable
  revision state, upload-kind control, ordered reference/logo areas, and Run S2
  QA control.
- The S2 QA route renders the visual-only disclosure and a safe traceable error
  envelope for an unknown synthetic run ID.

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
