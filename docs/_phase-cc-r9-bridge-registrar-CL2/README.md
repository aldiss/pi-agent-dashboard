# CC-r9 — Bridge-Pruner Canonical-Identity Recognition (dl-13727)

Lane bounded amendment in the SAME Build-1 picker transaction. Amended ON TOP of 211f7d8
(all prior commits preserved). **HELD: no settings.json mutation, no --register-bridge-only
run, no restart, no deploy, no push, no operator surface.** A frozen patch + tests + plan
for Pete. Zero AI attribution.

- Candidate worktree: `/Users/vdrobkov/build1-picker-cand-e0-wt`, branch `build1-picker-cand-attr`
- NEW code commit: **see report / git log** (on top of 211f7d8)

## The bug
The deploy shipped 211 but a STALE July-26 extension bridge at
`/private/tmp/build1-pw-20260726/dashboard/release/packages/extension` stayed registered in
`~/.pi/agent/settings.json` `packages`, AHEAD of the 211 bridge — so sessions loaded the
stale pre-receipt tool and ask_user returned "User responded: undefined". ROOT CAUSE:
`scripts/deploy.mjs` `registerBridge`'s `isDashboardBridge` recognized a dashboard bridge
ONLY by PATH SUBSTRING (`pi-agent-dashboard` / `pi-dashboard-prod`). The `/tmp` path had
neither, so it was never pruned. Both the stale AND the 211 extension declare canonical
identity `@blackbelt-technology/pi-dashboard-extension` (confirmed own-hand in live settings).

## The fix (`scripts/deploy.mjs`)
Recognize by CANONICAL PACKAGE IDENTITY, authoritative for existing paths, legacy substring
fallback ONLY for missing/unreadable paths. Three helpers moved to MODULE SCOPE + exported:
- `dashboardExtIdentity(p, readFile)` (`deploy.mjs:201`) → 'yes' (canonical name) / 'no'
  (different package — preserve) / 'unknown' (missing/unreadable — caller falls back).
- `isDashboardBridge(p, readFile)` (`deploy.mjs:208`) → identity-first; 'yes'→true,
  'no'→false, 'unknown'→legacy substring heuristic.
- `planPackages(pkgs, target, readFile)` (`deploy.mjs:223`) → `{kept, removed}`; prunes
  non-target dashboard bridges, keeps everything else, target EXACTLY ONCE (collapses a
  pre-existing duplicate; appends if absent — control #2).
- `registerBridge` now calls `planPackages(pkgs, target)` (was inline).
- `main()` guarded (`deploy.mjs:337`): `if (import.meta.url === pathToFileURL(process.argv[1]).href) main();`
  → the file is importable/testable WITHOUT running a deploy. Direct invocation
  (`node scripts/deploy.mjs …`) behaves EXACTLY as before (verified: no-arg dies "--ref
  required"; the existing child-process isolation test still passes 22/22).

### Note on a spec-faithful strengthening (disclosed)
The brief's reference `planPackages` snippet kept every `p === target` occurrence, which
would leave a pre-existing duplicate target twice. The brief's control #2 explicitly
requires the target retained EXACTLY ONCE "whether already present, duplicated, or absent".
To satisfy the stated contract, `planPackages` collapses duplicate target occurrences to
one (first position wins). For real settings (target never duplicated pre-deploy) the
output is byte-identical to the snippet; only the duplicated-input edge collapses.

## Tests — 5 controls + identity group (`scripts/deploy-bridge-registrar.test.mjs`)
vitest, imports `{ isDashboardBridge, planPackages, dashboardExtIdentity }` from
`./deploy.mjs`, temp fixture package.json dirs. Run own-hand GREEN (8/8):
`tests/registrar-tests-GREEN.log`.
- `dashboardExtIdentity` yes/no/unknown group (`test:71`).
- control 1 stale pruned (`test:86`) — includes an inline able-to-fail proof: the pre-fix
  substring predicate returns false for the /tmp stale path.
- control 2 target retained exactly once (`test:99`) — absent / present / duplicated.
- control 3 different-package + workflows preserved (`test:108`).
- control 4 missing legacy handled (`test:118`) — WITH substring pruned via fallback,
  WITHOUT preserved.
- control 5 idempotent (`test:130`).

**RED baseline** (`tests/registrar-tests-RED-prefix-baseline.log`): with `isDashboardBridge`
temporarily reverted to substring-only, controls #1 and #3 FAIL (the /tmp canonical bridge
is not recognized/pruned) — 2 failed / 6 passed. Restored to GREEN after capture.

The scripts vitest project (`scripts/vitest.config.ts`, narrow include) is added to root
`vitest.config.ts` projects; the sibling standalone `deploy-bridge-isolation.test.mjs` is
excluded from vitest collection (still runnable via `node`).

## Apply/rollback plan (HELD)
`APPLY-ROLLBACK-PLAN.md` — for Pete. Backup → `node scripts/deploy.mjs --register-bridge-only`
(real prod-root prunes the stale /tmp bridge, keeps release-211 once) → verify. Rollback =
restore `.bak-<UTC>`. CRITICAL: only fixes FUTURE session loads; already-running sessions
(incl. Lane tenure-67) are NOT repaired by this settings change.

## tsc/lint
Unaffected: 10 pre-existing errors (unchanged floor), zero in deploy.mjs or the new files.

## Manifest
`SHA256SUMS.ccr9.txt` — SHA-256 over all evidence files (self-verifying).
