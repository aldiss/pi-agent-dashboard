# D2 — Sequential Dual-Worktree Parity Verdict (CC-r7 dismiss-actor, CL2)

Pete dl-13527 required SEQUENTIAL full-suite runs (not concurrent) to remove the
parallel-load flakiness that muddied the r6 signal. Result: EXACT signature-set
equality — zero-new proven DIRECTLY (no isolation re-run needed; no divergent failures).

## Suites (identical invocation + env, run SEQUENTIALLY: candidate then baseline)

Invocation both worktrees:
`HOME=$(mktemp -d) NODE_OPTIONS="--localstorage-file=$(mktemp)" npx vitest run --reporter=json --reporter=default`

- CANDIDATE `7fc75b566ef51a70825cf429ffee433498961f06` (F1+F3 on 3055f8b)
  → 8 failed | 6673 passed | 17 skipped (6698). raw: `candidate-7fc-raw.log`, json: `candidate-7fc-results.json`
- BASELINE pristine `113263140666dee39721e2ef17e1db40a366cdc1`
  → 8 failed | 6580 passed | 17 skipped (6605). raw: `baseline-113-raw.log`, json: `baseline-113-results.json`

Pass delta +93 = the r6+r7 receipt/A1/B2 additions (incl. +7 new F1 tests), all green.
Counts are NOT the parity metric — the normalized failure-SIGNATURE sets are.

## Normalized failure signatures (`<wt-relative file> :: <full test name>`, sorted)

- CANDIDATE: `candidate-failsigs.txt` (8)
- BASELINE:  `baseline-failsigs.txt` (8)
- candidate-only (`candidate-only.txt`): **0**
- baseline-only  (`baseline-only.txt`):  **0**
- SHARED (`shared-failsigs.txt`): **8** — IDENTICAL environmental floor

## The 8 SHARED failures — pre-existing on untouched baseline, deterministic

7× `ChatView*.test.tsx` (jsdom icon/DOM-order rendering) + 1× `no-direct-process-kill`
lint (scans absolute paths). Present + identical on pristine 113 → not the slice.

## Conclusion

The candidate and baseline failure-signature sets are BYTE-FOR-BYTE IDENTICAL
(comm: 0 candidate-only, 0 baseline-only, 8 shared). Sequential execution eliminated
the r6 parallel-load flakes (auto-attach-slug-defense, headless-shutdown-fallback,
empty-bridge-replay-terminal) — none appeared in either run. ZERO-NEW failures proven
DIRECTLY: no failure is introduced by the F1 dismiss-actor fix or the F3 comment
corrections, and no failing file touches prompt-receipt/prompt-bus/protocol/
browser-gateway. The +7 new F1 tests all pass.
