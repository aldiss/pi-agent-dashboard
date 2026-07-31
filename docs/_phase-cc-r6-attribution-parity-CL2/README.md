# CC-r6 — Responder-Attribution Split (D1) + Parity Rigor (D2) — Evidence Bundle

Supervised by CommsLayer-2. Pete BLOCK dl-13383. NO push / NO deploy / NO
materialization / NO scope expansion beyond D1.

- Candidate worktree: `/Users/vdrobkov/build1-picker-cand-e0-wt`
- Branch: `build1-picker-cand-attr`
- NEW commit (D1 fix): **3055f8bf90db10f33013e2dfcfd749d8c78bcb12**
- Baseline (parity ref, read-only): `/Users/vdrobkov/build1-picker-base113-wt` @ `113263140666dee39721e2ef17e1db40a366cdc1`

## D1 — split answer-author from rendered-by (`d1/`)
The real bug: `receipt.author` conflated WHO ANSWERED with WHO RENDERED.
- `prompt-bus.ts` `respond()` L240-241: `author: response.author` (removed the
  `?? entry.renderedAuthor` fallback) + NEW `renderedBy: entry.renderedAuthor`.
- `prompt-bus.ts` `cancel()` L290: `renderedBy: entry.renderedAuthor`, `author` ABSENT
  (a bus timeout is not an answer).
- `prompt-receipt.ts` `deriveReceipt()` L145-146: `author` gated on present-answer;
  `renderedBy` carried separately. NEW `renderedBy?` on `ReceiptSource` + `PromptReceipt`.
- `ask-user-tool.ts`: unchanged — already embeds the whole receipt (answerer's `author`
  + separate `renderedBy` both flow) and gates "User responded" on `receipt.answered`
  (never emits `undefined`).

RED→GREEN (`d1/d1-tests-RED-prefix.log` = 9 fail pre-fix; `d1/d1-tests-GREEN-postfix.log`
= 70 pass post-fix; `d1/d1-source-fix.diff`):
- Test #1 operator-render→TUI-answer/cancel: `prompt-bus.test.ts:636` (#1a answer),
  `:659` (#1b cancel) — RED pre-fix (author would = operator).
- Test #2 dashboard-answer: `prompt-bus.test.ts:679` (+ `:697` distinct answerer/renderer).
- Test #3 rendered-timeout: `prompt-bus.test.ts:713` (+ `:737` never-rendered).
- Receipt-level split: `prompt-receipt.test.ts:142,153,165,171`.
Full extension suite post-fix: 52 files / 750 tests green (`d1/extension-full-suite-750-green.log`).

## D2 — dual-worktree parity, causal (`d2-parity/`, `tsc/`)
Identical full all-package suite both worktrees (`D2-VERDICT.md`):
- CANDIDATE 11 failed / 6663 passed; BASELINE 9 failed / 6579 passed. Counts differ by
  design (+86 test files on candidate). Parity metric = failure-SIGNATURE sets.
- 8 SHARED failures (env floor: jsdom ChatView, process.kill lint) — pre-existing on 113.
- 3 candidate-only + 1 baseline-only divergent failures — ALL proven flaky by CAUSAL
  single-file ISOLATION re-run passing on BOTH worktrees (`iso-*.json`), all byte-identical
  to baseline, zero D1 imports. ZERO D1-attributable failures.
- tsc delta 0 (`tsc/TSC-DELTA-VERDICT.md`): error identities byte-identical (10 pre-existing;
  App.tsx trio only line-shifted +8 by the picker slice); zero tsc errors in D1 files.

## §3 — actual-surface arms on the NEW identity (`arms/`)
All labeled `staged_head=3055f8bf...`. Isolated candidate dashboard, scratch 8153/8154,
loopback-guard, spawns pinned to :8154 (no cross-wire). See `arms/ARMS-SUMMARY.md`.
- arm3 malformed → `invalid:true`, no "User responded: undefined", D1 `no_author` — PASS.
- C2 multi-op → no-cookie 401, guest forged answer dropped, operator answer accepted with
  `author={operator}` AND `renderedBy={operator}` (split) — C2_PROVEN.
- arm2 A1-live → rendered-then-timeout: `renderedBy={operator}`, **author ABSENT**;
  never-rendered: neither — A1_LIVE_CONTRAST_PROVEN.
- Isolation BEFORE/DURING/AFTER: has9999=0 has8000=0 non_loopback=0; prod 113263140666
  pid 53346 untouched throughout. arm2 render ACK driven via raw /ws `prompt_rendered`
  (no chromium in env — disclosed; identical bridge→bus→receipt surface).

## Manifest
`SHA256SUMS.ccr6.txt` — SHA-256 over all 53 evidence files.
