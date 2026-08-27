# S2 G3 Fresh-Lineage Completion Audit

Date: 2026-08-28
Repository: `Swooshz-com/swooshz-design`
Branch: `web/run-010-s2-g3-fresh-lineage-reset`
Required canonical base: `68fbbb8653733554730d90316ce6e91719f1ffce`
Required starting head: `030a03aa45fb2e0fed2c11a0e399af75e2627228`
Pull request: #19, kept open and Draft
Scope: final ordinary Section-24 evidence-integrity repair 2/2 on the fresh lineage. Closed product/runtime roots were not reopened.

## Outcome

The final repair remains on the same branch and Draft PR. It does not reopen G1 or G2, launch a new G4 review, change the parent decision, enter S3, or use a live provider. Product/runtime files and the locked S2 contract remain unchanged.

The Section-24 proof now installs a test-scoped provider transport boundary around the normal evidence run. It classifies `127.0.0.1`, `localhost`, and `::1` as loopback, counts non-loopback dispatch attempts, counts forwarded transport separately, and fails closed before non-loopback I/O. The normal evidence run measured 0 non-loopback provider dispatch attempts and 0 network forwards. A separate controlled guard self-test intercepted 1 non-loopback attempt, forwarded 0 requests, and returned `PROVIDER_UNAVAILABLE`; it is not counted as a normal evidence-run provider call. The no-live-provider negative invokes the same assertion helper with a synthetic measured count of 1 and verifies rejection.

Each of the six `PRIV-001` callbacks now asserts its own exact synthetic marker is absent from captured console logs and the relevant safe envelopes, while the controlled fixtures prove the image, base64, prompt, provider-payload, evidence, and private-path markers actually enter their respective local input/provider paths. The canonical-base changed-surface secret scan, UI-002 ordering proof, and all previously closed lifecycle/runtime roots remain intact.

## Measured validation

| Gate | Result |
| --- | --- |
| `pnpm test` | 71 passed, 0 failed, 0 skipped |
| S1 and fresh lifecycle coverage | Passed, including real retry, dead-owner recovery, persistence reload, and negative graph fixtures |
| Section-24 evidence | 103 rows, 329 claims, missing 0, unknown 0, duplicate 0, skipped 0 |
| Normal Section-24 provider transport | 0 measured non-loopback dispatch attempts, 0 network forwards |
| Separate blocked guard probe | 1 intercepted non-loopback attempt, 0 network forwards, `PROVIDER_UNAVAILABLE` |
| No-live-provider negative | Passed; the shared assertion rejected synthetic measured count 1 |
| PRIV-001 exact marker bindings | Passed; all six callbacks asserted captured-log and safe-envelope absence |
| `pnpm typecheck` | Passed |
| `pnpm lint` | Passed; repository lint script runs the TypeScript check |
| `pnpm install --frozen-lockfile --offline` | Passed; lock remained frozen and up to date |
| `pnpm build` | Passed; reference and QA routes compiled |
| Native `sharp` load | Passed, version 0.35.3 |
| PDF.js version | 6.2.108; owner-authorized S1 exception preserved |
| `pnpm audit --prod` | No known vulnerabilities found |
| `git diff --check` | Passed |

The Section-24 matrix explicitly proves the queued-to-running and terminal journal records, retry and recovery paths, privacy-safe logs and envelopes, exact four-candidate UI ordering with no duplicate or omitted IDs, visibly distinct available and all-unavailable states, measured normal-run provider transport at 0/0, and changed-content secret-scan negatives. The negative self-tests also exercise a sensitive log marker, changed UI order, a synthetic measured provider count of 1, an injected credential-like fixture, and a falsified transition chain.

## Browser and security checks

The built app was served only on `127.0.0.1:3102` with `pnpm start --hostname 127.0.0.1 --port 3102`. Playwright opened the root route, observed the expected redirect to `/projects/new`, and rendered the expected `Create project` form. No synthetic project was created and the exact server process was stopped; the loopback port was closed afterward. The bundled wrapper could not run on this Windows host because its `bash.exe` had no `/bin/bash`, so the equivalent local Playwright CLI was run directly through `npx`.

Static review and deterministic tests covered the client/provider boundary, server-only storage keys, safe error logging, raw provider payload/error exclusion, changed-content hygiene, conflict paths, temporary/debug markers, and transition integrity. No live provider, provider credential, customer/private data, deployment, or destructive live action was used.

Codex Security was not available in this environment, so the audit uses the authorized manual/static fallback plus the targeted behavioral negative tests and production dependency audit. No deep-security scan was requested or run; this is a documented coverage limitation, not a claim that an unavailable scanner passed.

## Files and generated surfaces

The final publication changes only `tests/s2-evidence.test.ts`, `tests/s2-evidence-manifest.ts`, and this audit. No `src/lib/` or `app/` product/runtime file was changed. `package.json` and `pnpm-lock.yaml` were not changed; the pinned `sharp` and `pdfjs-dist` versions match the frozen lock. No generated source files were edited. Local `.playwright-cli/` and `.tmp/` state pre-existed and was preserved outside the publication diff; Section-24 artifacts were written to temporary locations.

## Plain-language interpretation

The product/runtime proof remains closed. This final evidence repair makes the proof honest: the normal Section-24 run measures 0 non-loopback provider dispatches and 0 forwards, the separate guard probe is recorded independently, and each privacy claim checks its own marker in captured logs and safe envelopes. The tests still actively try to leak secrets, reorder UI results, inject a credential, or skip a transition; those attempts fail safely.
