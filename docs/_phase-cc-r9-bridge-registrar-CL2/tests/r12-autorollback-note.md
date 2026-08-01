# r12 — automatic rollback on failure (docs-only; dl-13827)

Pete BLOCK **dl-13827** + Lane release: the r11 plan's post-verify failure path only *printed*
`roll back now` and exited 1 — it never **invoked** the rollback, so a rejected settings write
could stay live and recovery became a second manual action. **§23 requires rollback to be
automatic.** Code (`e6ae9b9`) unchanged; docs-only (`git diff e6ae9b9 -- scripts/` empty).

## What r12 changes (in `APPLY-ROLLBACK-PLAN.md`)
- **`rollback()` is a callable, hash-bound, atomic procedure defined BEFORE apply** (sibling-temp
  + JSON-validate + `chmod` + `renameSync`; emits a rollback receipt; returns nonzero unless
  `restored_sha === pre_sha` AND `restored_mode === pre_mode`).
- **`fail_apply()` is the automatic failure path:** emits an `applyFAIL` receipt (keeps the
  verifier's detailed FAIL receipt if present, else a minimal one), calls `rollback()`, proves
  final bytes+mode == PRE, and **exits nonzero** (exit 1 restored-to-PRE; exit 2 + manual flag if
  the rollback itself can't reach PRE).
- **Every post-mutation failure auto-invokes it:** `node "$DEPLOY" --register-bridge-only ||
  fail_apply "registrar-nonzero-exit"` and post-verify `… || fail_apply "postverify-failed"`.
- The whole APPLY is now **one self-contained transaction** — no printed "roll back now", no
  manual second step. Pre-mutation failures (backup-hash, fire-time PRE recheck) still plain-abort
  because nothing has been applied yet.

## Own-hand proof it exercises the REAL wrapper
`tests/r12-forced-failure-autorollback-proof.txt` — the **actual APPLY block, extracted verbatim
from the plan**, run under a temp HOME with **only the registrar faked** (the real
`rollback()`/`fail_apply()`/post-verify node-block execute; live settings never touched):
- CASE A — registrar writes a correct post-state → post-verify PASS → **no rollback → exit 0**.
- CASE B — registrar writes a bad post-state (stale left, release gone, unrelated corrupted) →
  post-verify FAIL → **auto-rollback fires** → rollback receipt `result=PASS`
  (`restored_sha === pre_sha`) → **exit 1** → temp settings restored == original PRE byte-identical.

## Holds (unchanged)
No live settings mutation, no `--register-bridge-only` against real prod-root, no restart, no
deploy, no push, no operator surface, no door-2/3 interleaving. Does NOT repair already-running
sessions. Live apply remains Lane-gated (CommsLayer/Lane executes; Pete verifies only).
