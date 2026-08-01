# r14 — evidence classification: STATE separate from EVIDENCE (docs-only; dl-13852)

Pete/Lane (dl-13852): r13 conflated two independent things. Its CONTROL 1 (apply-receipt sink
failure on an otherwise-PASSing apply) printed **"AUTO-ROLLBACK OK" / exit 1** and **named the
absent apply-receipt path as a present receipt** — when in fact the apply receipt was missing
(evidence incomplete). r14 separates **STATE** (settings restored to PRE) from **EVIDENCE** (all
required receipts present + valid). Code (`e6ae9b9`) unchanged; docs-only (`git diff e6ae9b9 --
scripts/` empty).

## What r14 changes (in `APPLY-ROLLBACK-PLAN.md`)
- **`receipt_valid()` helper** — a receipt is a REAL, JSON-valid file; an absent/dir/invalid path is
  never treated (or named) as a receipt.
- **`fail_apply()` evaluates two axes:**
  - **STATE:** rollback rc `0`/`3` = settings restored to PRE; rc `1`/`2` = NOT restored → **exit 2**
    (MANUAL INTERVENTION), state dominates.
  - **EVIDENCE (only when restored):** exit **1** "AUTO-ROLLBACK OK" **only if BOTH** the apply and
    rollback receipts are present+valid; if any required receipt is missing → exit **3**
    "AUTO-ROLLBACK EVIDENCE-INCOMPLETE: settings restored to PRE (safe), missing required
    receipt(s): …; present receipt(s): …" — **never "OK"**, and **only present paths are named as
    receipts** (missing ones are flagged `NOT-written`, no path claimed as a receipt).
- **Exit-code table** updated to state the axis split: `0` PASS · `1` rolled-back + all receipts
  present · `2` NOT restored (MANUAL) · `3` restored but evidence incomplete.

## Own-hand proof (real wrapper; temp HOME; live never touched; explicit assertions)
- `tests/r12-forced-failure-autorollback-proof.txt` — CASE A GOOD → exit 0 PASS; CASE B BAD →
  exit 1 "AUTO-ROLLBACK OK", both receipts valid, settings==PRE (all asserts PASS).
- `tests/r13-receipt-sink-controls-proof.txt` — the two receipt-sink controls, now asserting the
  axis split:
  - **CONTROL 1** (apply-receipt sink fails): **exit 3**; asserts no "OK", **apply receipt ABSENT**,
    **rollback receipt VALID**, final PRE bytes+mode, distinct nonzero — all PASS.
  - **CONTROL 2** (rollback-receipt sink fails): **exit 3**; asserts no "OK", **apply receipt VALID**,
    **rollback receipt ABSENT**, final PRE bytes+mode — all PASS.

## Holds (unchanged)
No live settings mutation, no `--register-bridge-only` against real prod-root, no restart, no deploy,
no push, no operator surface, no door-2/3 interleaving. Does NOT repair already-running sessions.
Live apply remains Lane-gated (CommsLayer/Lane executes; Pete verifies only).
