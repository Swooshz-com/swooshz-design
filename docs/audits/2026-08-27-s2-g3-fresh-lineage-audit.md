# S2 G3 Fresh-Lineage Completion Audit

Date: 2026-08-27
Branch: `web/run-010-s2-g3-fresh-lineage-reset`
Required base: `68fbbb8653733554730d90316ce6e91719f1ffce`
Scope: fresh S2 implementation for `DL-SD-S2-G2-003`, with PR #17 used only as read-only diagnostic reference.

## Outcome

The fresh implementation is independently based on canonical `main`. Source QA now has an explicit monotonic lifecycle: a pristine all-queued campaign is `queued`; any started incomplete campaign is `running`; four terminal latest candidate results are `completed`; explicit attempt-2 source retry reopens only source QA and never reports `queued`. Repair and re-QA remain independent of source-run lifecycle and counters.

## Measured validation

| Gate | Result |
| --- | --- |
| `pnpm test` | 71 passed, 0 failed, 0 skipped |
| S1 `tests/g3.test.ts` | 41 passed, 0 failed |
| Fresh lifecycle suite | 4 passed, including real retry and dead-owner recovery |
| Section-24 evidence | 103 rows, 329 claims, missing 0, unknown 0, duplicate 0, skipped 0 |
| `pnpm typecheck` | passed |
| `pnpm lint` | passed (repository lint script runs TypeScript check) |
| `pnpm install --frozen-lockfile --offline` | passed; already up to date |
| `pnpm build` | passed; S2 reference and QA routes compiled |
| Native `sharp` load | passed, 0.35.3 |
| PDF.js version | 6.2.108, owner-authorized S1 exception preserved |
| `pnpm audit --prod` | 0 info/low/moderate/high/critical vulnerabilities |
| `git diff --check` | passed before publication |

The execution-bound fixtures prove the never-started queued state, started partial/requeued running state, explicit retry no-queued regression, retry completion, latest-attempt counters, two independent candidate repairs, attempt-2 repair, and source-run independence through repair/re-QA states. Provider and publication recovery fixtures cover conservative unknown liveness and definitely-dead owners without duplicate dispatch or orphan-success claims.

## Browser and security checks

The built app was served only on `127.0.0.1:3100` with `pnpm exec next start -H 127.0.0.1 -p 3100`. A real browser smoke rendered the landing page, created a synthetic local project, reached the geometry workflow, and confirmed that direct S2 navigation respects the S1 precondition rather than fabricating an S2 state. The owned server process was stopped and port 3100 was verified closed.

Static review covered the client/provider boundary, private server-only storage keys, safe error logging, no raw provider payload/error leakage, changed-content hygiene, conflict paths, and temporary/debug markers. No live provider, provider credential, customer/private data, deployment, or destructive live action was used. No deep-security scan was requested or run. CI status is a publication-time check and is not represented as locally passed here.

## Files and generated surfaces

The source of truth is the implementation and tests in `src/lib/`, `app/`, and `tests/`; `pnpm-lock.yaml` was updated for the locked dependency changes. Local `.next/`, `.playwright-cli/`, `.tmp/`, and toolkit backup material remain untracked workspace state and are not part of the implementation or publication. Section-24 evidence artifacts were written to temporary directories outside the repository.
