# r13 — bash + PIPESTATUS + receipt-sink handling (docs-only; dl-13845)

Pete/Lane (dl-13845): the r12 wrapper checked only `${PIPESTATUS[0]}` (the verifier), missed the
`tee` (receipt-sink) status, was implicitly bash without saying so, and a rollback-receipt sink
failure could still print a clean "AUTO-ROLLBACK OK". r13 closes these. **Code (`e6ae9b9`)
unchanged; docs-only** (`git diff e6ae9b9 -- scripts/` empty).

## What r13 changes (in `APPLY-ROLLBACK-PLAN.md`)
1. **Explicit bash.** `#!/usr/bin/env bash` + a "run under bash" note — `PIPESTATUS` is a bashism.
2. **Capture producer + tee status IMMEDIATELY.** After the post-verify `node … | tee
   "$RECEIPT_APPLY"`, the very next line is `APPLY_ST=("${PIPESTATUS[@]}")`; `prod=${APPLY_ST[0]}`
   (verifier), `teerc=${APPLY_ST[1]}` (apply-receipt sink). Same pattern inside `rollback()` for the
   rollback-receipt `tee`.
3. **Apply-receipt sink failure ⇒ fail_apply + rollback.** `prod != 0` → `fail_apply postverify-failed`;
   `teerc != 0` → `fail_apply apply-receipt-sink-failed`. No recorded apply receipt ⇒ revert to PRE
   (conservative: a mutation we cannot prove is rolled back).
4. **Rollback-receipt sink failure ⇒ loud nonzero, accurate wording, no false OK.** `rollback()`
   returns distinct codes: `0` restored + receipt written; `3` **PRE bytes+mode restored (settings
   safe) but the rollback receipt could not be written**; `1` NOT restored to PRE; `2` backup
   unusable. `fail_apply()` maps them to accurate messages and exits `1` / `3` / `2` respectively —
   a `3` says "PRE RESTORED (safe), receipt sink failed; investigate", never "AUTO-ROLLBACK OK".
5. **Documented exit-code table** at the top of the APPLY section: `0` PASS · `1` failed+rolled-back
   clean · `2` failed+rollback-couldn't-restore (MANUAL) · `3` failed+PRE-restored-but-receipt-sink.
6. **Testable receipts.** `: "${UTC:=…}"` honors a caller-provided `UTC` (else computes) so the
   receipt paths are deterministic — which is what lets the able-to-fail controls force a sink failure.

## Own-hand proof (real wrapper; temp HOME; live never touched)
- `tests/r12-forced-failure-autorollback-proof.txt` (regenerated against the r13 wrapper) —
  CASE A GOOD → PASS/exit 0; CASE B BAD → auto-rollback → restored==PRE → exit 1.
- `tests/r13-receipt-sink-controls-proof.txt` — two receipt-sink able-to-fail controls (receipt path
  pre-created as a directory so `tee` fails):
  - CONTROL 1 (apply-receipt sink fails on a PASSing apply): `fail_apply(apply-receipt-sink-failed)`
    → auto-rollback → settings == PRE → **exit 1**.
  - CONTROL 2 (rollback-receipt sink fails): post-verify FAIL → rollback restores PRE bytes → receipt
    `tee` fails → **exit 3**, message "PRE bytes+mode RESTORED (settings safe), but the rollback
    receipt could NOT be written" — settings == PRE, **no false AUTO-ROLLBACK OK**.

## Holds (unchanged)
No live settings mutation, no `--register-bridge-only` against real prod-root, no restart, no deploy,
no push, no operator surface, no door-2/3 interleaving. Does NOT repair already-running sessions.
Live apply remains Lane-gated (CommsLayer/Lane executes; Pete verifies only).
