# S2 G3 Fresh-Lineage Completion Audit

Date: 2026-08-28
Repository: `Swooshz-com/swooshz-design`
Branch: `web/run-010-s2-g3-fresh-lineage-reset`
Required canonical base: `68fbbb8653733554730d90316ce6e91719f1ffce`
Required starting head: `dafb09c97202bc35d28b15270e2ec713bc55617e`
Pull request: #19, kept open and Draft
Scope: the two fresh repair roots authorized by the G4 AMEND review: complete the locked S2 transition history and replace the invalid Section-24 proof with claim-specific behavioral evidence.

## Outcome

The fresh-lineage repair remains on the same branch and PR. It does not reopen G1 or G2, launch a new G4 review, change the parent decision, enter S3, or use a live provider. The implementation keeps the existing S2Transition record and makes each committed real transition persist atomically with the domain update.

The transition validator now requires a non-empty, ordered, contiguous history for every S2 operation. It checks exact project, operation, phase, attempt, and reference identity; legal starts and ends; timestamp order; recovery topology; retry authorization; and agreement between the final journal record and the current persisted operation/domain state. Recovery paths journal only when the state change commits.

The Section-24 proof now exercises the real local S2 service and provider boundary for privacy success, provider failure, API error, and private-object handling; derives UI candidate order from the actual persisted server projection and production renderer helper; measures the loopback-only provider guard; scans the canonical-base changed tracked surface with redacted controlled-secret negatives; and preserves the locked dependency metadata.

## Measured validation

| Gate | Result |
| --- | --- |
| `pnpm test` | 71 passed, 0 failed, 0 skipped |
| S1 and fresh lifecycle coverage | Passed, including real retry, dead-owner recovery, persistence reload, and negative graph fixtures |
| Section-24 evidence | 103 rows, 329 claims, missing 0, unknown 0, duplicate 0, skipped 0 |
| `pnpm typecheck` | Passed |
| `pnpm lint` | Passed; repository lint script runs the TypeScript check |
| `pnpm install --frozen-lockfile --offline` | Passed previously; lock remained frozen and up to date |
| `pnpm build` | Passed; reference and QA routes compiled |
| Native `sharp` load | Passed, version 0.35.3 |
| PDF.js version | 6.2.108; owner-authorized S1 exception preserved |
| `pnpm audit --prod` | No known vulnerabilities found |
| `git diff --check` | Passed |

The Section-24 matrix explicitly proves the queued-to-running and terminal journal records, retry and recovery paths, privacy-safe logs and envelopes, exact four-candidate UI ordering with no duplicate or omitted IDs, visibly distinct available and all-unavailable states, zero live-provider calls, and changed-content secret-scan negatives. The negative self-tests also exercise a sensitive log marker, changed UI order, a nonzero live-call count, an injected credential-like fixture, and a falsified transition chain.

## Browser and security checks

The built app was served only on `127.0.0.1:3102` with `pnpm start --hostname 127.0.0.1 --port 3102`. Playwright opened the root route, observed the expected redirect to `/projects/new`, and rendered the expected `Create project` form. No synthetic project was created and the exact server process was stopped; the loopback port was closed afterward. The bundled wrapper could not run on this Windows host because its `bash.exe` had no `/bin/bash`, so the equivalent local Playwright CLI was run directly through `npx`.

Static review and deterministic tests covered the client/provider boundary, server-only storage keys, safe error logging, raw provider payload/error exclusion, changed-content hygiene, conflict paths, temporary/debug markers, and transition integrity. No live provider, provider credential, customer/private data, deployment, or destructive live action was used.

Codex Security was not available in this environment, so the audit uses the authorized manual/static fallback plus the targeted behavioral negative tests and production dependency audit. No deep-security scan was requested or run; this is a documented coverage limitation, not a claim that an unavailable scanner passed.

## Files and generated surfaces

The source of truth is the implementation and tests in `src/lib/`, `app/`, and `tests/`, plus this canonical audit. `package.json` and `pnpm-lock.yaml` were not changed; the pinned `sharp` and `pdfjs-dist` versions match the frozen lock. No generated source files were edited. Local `.playwright-cli/` and `.tmp/` state pre-existed and was preserved outside the publication diff; Section-24 artifacts were written to temporary locations.

## Plain-language interpretation

Every real S2 status change now leaves a same-transaction receipt saying what changed, which attempt it belonged to, and which operation caused it. The UI gets candidates in a known order, and the tests actively try to make logs leak secrets, make the UI reorder results, call a live provider, inject a credential, or skip a transition; those attempts fail safely.
