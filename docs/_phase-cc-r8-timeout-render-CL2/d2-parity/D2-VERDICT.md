# D2 — Sequential Dual-Worktree Parity Verdict (CC-r8 timeout-render, CL2)

Pete dl-13559 required SEQUENTIAL full-suite runs. Result: EXACT signature-set equality.

## Suites (identical invocation + env, run SEQUENTIALLY: candidate then baseline)

Invocation both worktrees:
`HOME=$(mktemp -d) NODE_OPTIONS="--localstorage-file=$(mktemp)" npx vitest run --reporter=json --reporter=default`

- CANDIDATE `4937a8ea061f6779cde5faf1cf7c4d184a641a4f` (timeout-render fix on 7fc75b5)
  → 8 failed | 6686 passed | 17 skipped (6711). raw: `candidate-4937-raw.log`, json: `candidate-4937-results.json`
- BASELINE pristine `113263140666dee39721e2ef17e1db40a366cdc1`
  → 8 failed | 6580 passed | 17 skipped (6605). raw: `baseline-113-raw.log`, json: `baseline-113-results.json`

Pass delta +106 = the r6+r7+r8 receipt/A1/B2 + timeout-render additions (incl. +13 new
r8 tests), all green. Counts are NOT the parity metric — the failure-SIGNATURE sets are.

## Normalized failure signatures (`<wt-relative file> :: <full test name>`, sorted)

- CANDIDATE: `candidate-failsigs.txt` (8)
- BASELINE:  `baseline-failsigs.txt` (8)
- candidate-only (`candidate-only.txt`): **0**
- baseline-only  (`baseline-only.txt`):  **0**
- SHARED (`shared-failsigs.txt`): **8** — IDENTICAL environmental floor

## The 8 SHARED failures — pre-existing on untouched baseline, deterministic

7× `ChatView*.test.tsx` (jsdom icon/DOM-order rendering) + 1× `no-direct-process-kill`
lint. Present + identical on pristine 113 → not the slice.

## Conclusion

Candidate and baseline failure-signature sets are BYTE-FOR-BYTE IDENTICAL (comm: 0
candidate-only, 0 baseline-only, 8 shared). ZERO-NEW failures proven DIRECTLY. No failure
is introduced by the timeout-render fix (cancelInteractiveRequest + prompt_cancel reroute
+ 6 renderers cancelled→"No response"), and no failing file touches
event-reducer/useMessageHandler/the renderers/prompt-bus. The +13 new r8 tests all pass.
tsc delta 0 (`../tsc/TSC-DELTA-VERDICT.md`).
