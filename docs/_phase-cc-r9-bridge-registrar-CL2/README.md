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

## r10 amendment (dl-13803 / dl-13808) — three gaps closed on top of cf70b17
Pete BLOCKED cf70b17 with three real gaps; the r9 body above stands (identity-first
pruning + pure plan + RED2→GREEN8 + isolation22 + honest holds). r10 fixes:

- **Gap 1 — importability (was falsely claimed).** `scripts/deploy.mjs:33`
  `REPO = resolve(process.argv[1], …)` ran at load and threw `ERR_INVALID_ARG_TYPE`
  under `import()`/`node -e` (argv[1] undefined) — it only imported under vitest. Fixed:
  REPO now derives from `resolve(fileURLToPath(import.meta.url), "..", "..")` (same repo
  root for direct invocation), and the `main()` guard is argv[1]-undefined-safe
  (`const invoked = process.argv[1]; if (invoked && import.meta.url === pathToFileURL(invoked).href) main();`).
  Control tests (`deploy-bridge-registrar.test.mjs` "importability (dl-13803)"): dynamic
  `node -e` import exits 0 (no throw); static ESM import exposes the helpers; direct
  invocation still runs main() (no-arg → die "--ref required"). RED baseline
  (`tests/r10-importability-RED-baseline.log`): on the pre-fix `process.argv[1]` REPO the
  dynamic-import control FAILS with ERR_INVALID_ARG_TYPE (1 failed / 10 passed).

- **Gap 2 — e2e `--register-bridge-only` integration** (`scripts/deploy-register-bridge-e2e.test.mjs`).
  Temp-HOME test invoking the REAL registerBridge via `execFileSync`. Asserts, against the
  WRITTEN `$HOME/.pi/agent/settings.json`: stale canonical bridge pruned; release extension
  present EXACTLY ONCE using a REALPATH-NORMALIZED expected target (macOS `/var/folders`→
  `/private/var/folders`); unrelated `@other/ext` + `npm:something` preserved; non-dashboard
  top-level keys (`defaultModel`/`thinking`) byte-unchanged; release plugin-bridge pinned +
  stale `dashboard-*` repinned + non-dashboard `keepme` preserved. A SECOND run is
  BYTE-IDENTICAL (idempotent). The operator's REAL `~/.pi/agent/settings.json` is proven
  untouched (mtime before === after). 13/13 GREEN (`tests/r10-scripts-GREEN-13.log`).

- **Gap 3 — apply/rollback plan rewritten** (`APPLY-ROLLBACK-PLAN.md`): LANE/Comms-owned
  (Pete verifier only), hash-bound (sha256 pre/post + backup-hash===pre), same-directory-temp
  atomic apply AND rollback (`renameSync` same-fs, NOT plain `cp`), JSON-validated, full
  unrelated-state proof (masked-diff on apply, full-hash-equality on rollback). Critical
  no-running-session-repair note retained.

Holds honored: no live settings mutation (stale /tmp bridge still present in real settings —
verified read-only), no `--register-bridge-only` against the real prod-root, no restart/deploy/
push. deploy.mjs-only (no door-2/3 interleave). r10 logs: `tests/r10-*`.

## r11 — plan hardening (docs-only; dl-13823 / dl-13824)
Pete BLOCK dl-13823 / Lane release dl-13824: the r10 plan's verifiers only *printed* booleans
/ `echo OK || echo MISMATCH` and exited 0 on mismatch. r11 makes every pre-, post-apply and
rollback condition **executable and nonzero-exit on mismatch**, binds the apply to the exact
clean `e6ae9b9` code (deploy.mjs blob `60db298…`), adds an immediate fire-time `PRE_SHA`/`PRE_MODE`
recheck, asserts exact target/plugin/unrelated-state/mode, sibling-temp atomic rollback with
hash+mode hard-fail, and a machine-checkable **receipt** schema. **Code (`e6ae9b9`) unchanged**
(`git diff e6ae9b9 -- scripts/` empty) — docs-only. Own-hand proof the verifier hard-fails:
`tests/r11-verifier-hardfail-proof.txt` (correct → PASS/exit 0; stale-present → FAIL/exit 1).
See `tests/r11-plan-hardening-note.md`. Holds unchanged (no live apply/restart/deploy/push, no
door-2/3 interleave, no running-session repair).

## r12 — automatic rollback on failure (docs-only; dl-13827)
Pete BLOCK dl-13827: the r11 plan's post-verify failure path only *printed* `roll back now` and
exited 1 — it never invoked rollback, so a rejected write could stay live (§23 requires automatic
rollback). r12 makes APPLY one self-contained transaction: `rollback()` is a callable hash-bound
atomic procedure defined before apply, and any post-mutation failure (registrar / post-verify)
auto-invokes `fail_apply()` → applyFAIL + rollback receipts → proves final bytes+mode == PRE →
exits nonzero. **Code (`e6ae9b9`) unchanged** (docs-only). Own-hand proof exercising the REAL
wrapper (apply block extracted verbatim, temp HOME, only registrar faked):
`tests/r12-forced-failure-autorollback-proof.txt` (CASE A GOOD→PASS/exit 0/no-rollback; CASE B
BAD→auto-rollback→restored==PRE→exit 1). See `tests/r12-autorollback-note.md`.

## r13 — bash + PIPESTATUS + receipt-sink handling (docs-only; dl-13845)
r12 checked only the verifier `${PIPESTATUS[0]}`, missed the `tee` (receipt-sink) status, was
implicitly bash, and a rollback-receipt sink failure could still print a clean "AUTO-ROLLBACK OK".
r13: explicit `#!/usr/bin/env bash`; capture producer+tee `PIPESTATUS` IMMEDIATELY; apply-receipt
sink failure → `fail_apply`+rollback; rollback-receipt sink failure → loud nonzero exit 3 with
accurate "PRE restored (safe) but receipt sink failed" wording (no false OK); documented exit-code
table (0/1/2/3). **Code (`e6ae9b9`) unchanged** (docs-only). Own-hand proofs (real wrapper, temp
HOME): `tests/r12-forced-failure-autorollback-proof.txt` (regenerated) + `tests/r13-receipt-sink-
controls-proof.txt` (2 able-to-fail sink controls). See `tests/r13-shell-hardening-note.md`.

## r14 — evidence classification: STATE separate from EVIDENCE (docs-only; dl-13852)
r13 conflated two things: its apply-receipt-sink control printed "AUTO-ROLLBACK OK" / exit 1 and
named the ABSENT apply-receipt path as a present receipt. r14 separates STATE (settings restored to
PRE) from EVIDENCE (required receipts present+valid): a `receipt_valid()` helper gates naming; rc
0/3=restored, 1/2=not→exit 2; when restored, exit 1 "OK" ONLY if BOTH receipts present+valid, else
exit 3 EVIDENCE-INCOMPLETE (never "OK", only present paths named as receipts). Exit-code table
updated. **Code (`e6ae9b9`) unchanged** (docs-only). Own-hand proofs with explicit assertions (real
wrapper, temp HOME): CASE A exit0 / CASE B exit1-OK-both-receipts / CONTROL 1 exit3-apply-absent /
CONTROL 2 exit3-rollback-absent — all ALL-PASS. See `tests/r14-evidence-classification-note.md`.

## Manifest
`SHA256SUMS.ccr9.txt` — SHA-256 over all evidence files (self-verifying; regenerated at r14).
