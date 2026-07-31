# D2 — Dual-Worktree Parity Verdict (CC-r6 attribution split, CL2)

Causal zero-new-failure proof. NOT keyword-based. Every divergent failure re-run
single-file in ISOLATION (no parallel load) on BOTH worktrees.

## Suites (identical invocation + env, `npm test` script shape)

Invocation both worktrees:
`HOME=$(mktemp -d) NODE_OPTIONS="--localstorage-file=$(mktemp)" npx vitest run --reporter=json --reporter=default`

- BASELINE pristine `113263140666dee39721e2ef17e1db40a366cdc1`
  → 9 failed | 6579 passed | 17 skipped (6605). raw: `baseline-113-raw.log`, json: `baseline-113-results.json`
- CANDIDATE `e0e8407` + D1 fix (branch build1-picker-cand-attr, pre-commit HEAD at run time)
  → 11 failed | 6663 passed | 17 skipped (6691). raw: `candidate-e0-raw.log`, json: `candidate-e0-results.json`

Count delta explained: CANDIDATE carries +86 tests (receipt/A1/B2 files absent on
prod base + the +12 new D1 tests, all passing). Counts are NOT the parity metric —
the normalized failure-SIGNATURE sets are.

## Normalized failure signatures (`<wt-relative file> :: <full test name>`, sorted)

- CANDIDATE: `candidate-failsigs.txt` (11)
- BASELINE:  `baseline-failsigs.txt` (9)
- SHARED (both): `shared-failsigs.txt` (8) — the stable pre-existing environmental floor
- CANDIDATE-only: `candidate-only.txt` (3)
- BASELINE-only:  `baseline-only.txt` (1)

## SHARED floor (8) — deterministic, pre-existing on untouched baseline

7× `ChatView*.test.tsx` (jsdom icon/DOM-order rendering) + 1× `no-direct-process-kill`
lint (scans absolute paths). Present + identical on pristine 113 → not the slice.

## Divergent failures — CAUSAL isolation proof (all pass isolated on BOTH)

| signature | file identical base↔cand | imports D1 (prompt-bus/receipt/ask-user) | isolated CAND | isolated BASE |
|---|---|---|---|---|
| auto-attach-slug-defense :: rename rejects non-slug | yes (0 diff) | no | PASS | PASS |
| headless-shutdown-fallback :: SIGTERM when bridge disconnected | yes (0 diff) | no | PASS | PASS |
| headless-shutdown-fallback :: no crash when no PID linked | yes (0 diff) | no | PASS | PASS |
| empty-bridge-replay-terminal :: 5s fallback terminal after reset (BASE-only) | yes (0 diff) | no | PASS | PASS |

Isolation evidence:
- `iso-cand.json` — 3 candidate-only tests, server-project isolated on CANDIDATE → passed=3 failed=0
- `iso-base.json` — same 3 tests, isolated on BASELINE → passed=3 failed=0
- `iso-baseonly-CAND.json` — baseline-only file isolated on CANDIDATE → passed=2 failed=0
- `iso-baseonly-BASE.json` — baseline-only file isolated on BASELINE → passed=2 failed=0

## Conclusion

Every divergent failure is a parallel-load/scheduling FLAKE: passes deterministically
when run single-file with no concurrent load, on BOTH the candidate AND the untouched
pristine baseline. The candidate's +86 added test files shift vitest's scheduler, so a
DIFFERENT member of the same pre-existing timing-sensitive pool flakes per run (baseline
flaked `empty-bridge-replay-terminal`; candidate flaked `auto-attach-slug-defense` +
`headless-shutdown-fallback`) — NOT a D1 regression.

ZERO-NEW verified causally: no failing file imports or exercises the D1-touched modules
(`prompt-bus.ts`, `prompt-receipt.ts`), every divergent file is byte-identical to
baseline, and every divergent failure is isolation-green on both worktrees. The +12 new
D1 tests all pass. No failure is attributable to the responder-attribution split.
