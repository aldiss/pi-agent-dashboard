# r15 — receipt contract + rollback producer+sink status (docs-only; dl-13863 / dl-13859)

Fix only dl-13859. Code (`e6ae9b9`) unchanged; docs-only (`git diff e6ae9b9 -- scripts/` empty).
Retains A/B/C1/C2, bash, `receipt_valid()`, exit-code table.

## What r15 changes (in `APPLY-ROLLBACK-PLAN.md`)
1. **Top receipt contract.** Added at the top of the APPLY section: receipts are **ATTEMPTED
   (best-effort), NOT guaranteed** — a producer *or* sink failure can leave a required receipt
   missing or invalid; a missing/invalid required receipt ⇒ settings restored to PRE /
   evidence-incomplete / **exit 3** (never "OK").
2. **`rollback()` checks BOTH producer and sink.** `RB_SINK=("${PIPESTATUS[@]}")` — the rollback
   receipt counts as complete only if **BOTH** `RB_SINK[0]` (the `printf` producer) **AND**
   `RB_SINK[1]` (the `tee` sink) are zero. Previously only the tee status was checked, so a
   nonzero producer with a healthy sink would have been silently credited. On either nonzero →
   `ROLLBACK RECEIPT NOT COMPLETE (producer=… sink=…)` → return 3 (settings are restored to PRE).
   (The apply-receipt path already checks BOTH its producer — the `node` verifier — and its tee.)

## Own-hand proof (real wrapper; temp HOME; live never touched; explicit assertions)
- `tests/r12-forced-failure-autorollback-proof.txt` — CASE A exit 0; CASE B exit 1 "OK", both
  receipts valid, PRE.
- `tests/r13-receipt-sink-controls-proof.txt` — CONTROL 1 (apply-receipt sink) exit 3, apply
  ABSENT / rollback VALID / PRE; CONTROL 2 (rollback-receipt sink) exit 3, `producer=0 sink=1`,
  apply VALID / rollback ABSENT / PRE.
- `tests/r15-producer-status-control-proof.txt` — **CONTROL 3 (producer-nonzero / tee-zero):** the
  rollback-receipt `printf` producer is forced to exit nonzero while `tee` succeeds
  (`producer=1 sink=0`). Because `rollback()` now requires BOTH zero, the rollback receipt is **NOT
  credited** → **exit 3**; asserts no "OK", `ROLLBACK RECEIPT NOT COMPLETE`, rollback receipt not
  credited, apply receipt valid, settings restored == PRE bytes+mode — all PASS.

## Holds (unchanged)
No live settings mutation, no `--register-bridge-only` against real prod-root, no restart, no deploy,
no push, no operator surface, no door-2/3 interleaving. Does NOT repair already-running sessions.
Live apply remains Lane-gated (CommsLayer/Lane executes; Pete verifies only).
