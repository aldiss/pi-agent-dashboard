# CC-r7 — Dismiss-Actor Preserve (F1) + Stale-Comment Fix (F3) + All-Arms-Fresh (F2)

Pete BLOCK dl-13527, amended ON TOP of 3055f8b (r6 commits 3055f8b + 01e9cfd preserved).
NO push / deploy / materialize / operator-solicitation. Zero AI attribution. No scope
expansion. build1-comms-prod-wt never touched. Prod (:8000/:9999, pid 53346,
113263140666) untouched throughout.

- Candidate worktree: `/Users/vdrobkov/build1-picker-cand-e0-wt`, branch `build1-picker-cand-attr`
- NEW FIX commit: **7fc75b566ef51a70825cf429ffee433498961f06**
- Baseline (parity ref, read-only): `113263140666dee39721e2ef17e1db40a366cdc1`

## F1 — deriveReceipt drops the authenticated-dismiss actor (`f1/`)
The r6 gate `if (answerPresent && response.author)` (prompt-receipt.ts) dropped the
responder author on a cancelled/dismiss response. The browser gateway
(`buildPromptResponseForward`) server-stamps `author` on ANY prompt_response —
including an authenticated dismiss (cancelled:true, no answer) — so the operator
dismisser's identity was lost.

Fix (prompt-receipt.ts L153): `if (response.author) base.author = response.author;`
— `author` = the RESPONDER actor (answerer OR authenticated dismisser), surfaced
whenever the responder carried one, INDEPENDENT of answer-presence. `renderedBy`
stays separate (the RENDERER). Render identity never leaks into `author`: respond()
sets author=response.author (responder-only), cancel() sets none, render author →
entry.renderedAuthor → renderedBy. `answered` unchanged (`!cancelled && answerPresent`),
so a dismiss stays `answered:false`; ask-user-tool still gates "User responded" on
receipt.answered. Type/doc comments (ReceiptSource.author, PromptReceipt.author)
updated to the RESPONDER semantic.

RED→GREEN (`f1/f1-tests-RED-prefix.log` = 4 fail pre-fix; `f1/f1-tests-GREEN-postfix.log`
= 130 pass post-fix; `f1/f1-f3-source.diff`). The 5 brief tests (file:line):
1. authenticated dashboard DISMISS preserves author: `prompt-receipt.test.ts:198`
   (RED pre-fix) + distinct dismisser/renderer `:207`.
2. TUI cancel authorless: `prompt-receipt.test.ts:215`.
3. bus timeout authorless + renderedBy: `prompt-receipt.test.ts:222`.
4. operator-render→TUI-answer regression guard: `prompt-receipt.test.ts:229`.
5. full PromptBus.respond() cancelled+authored path preserves author:
   `prompt-bus.test.ts:758` (RED pre-fix) + distinct `:779`.
Full extension suite post-fix: 52 files / 757 tests green (`f1/extension-full-suite-757-green.log`).

## F3 — stale render-ACK→receipt.author doc-comments corrected (`f1/f1-f3-source.diff`)
The render-ACK author threads into receipt.renderedBy, NOT receipt.author:
- `protocol.ts:663` (PromptRenderedServerMessage.author doc) → receipt.renderedBy.
- `browser-gateway.ts:797` (prompt_rendered handler) → receipt.renderedBy.
grep-clean: no other stale render-ACK→receipt.author claim outside tests; all remaining
`receipt.author` mentions are correct answer/dismiss-author references.

## F2 — all six actual-surface arms fresh on the NEW identity (`arms/`)
Chromium installed (`npx playwright install chromium` → chromium-1217). Isolated
candidate dashboard, temp HOME, scratch 8155/8156, loopback-guard, multi-op config,
spawns pinned to :8156. All labeled `staged_head=7fc75b5...`. See `arms/ARMS-SUMMARY.md`.
- **arm1** opt1 bijection (REAL DOM click): returned==original[1], answered — PASS.
- **arm2** A1-live REAL DOM MOUNT + SCREENSHOT: rendered-then-timeout →
  renderedBy={operator}, author ABSENT; never-rendered → neither. dialog_mounted=true,
  screenshots `arms/arm2/rendered-mounted.png` + `rendered-postTimeout.png` — PASS.
- **arm3** malformed → invalid, no "User responded: undefined"; author={operator}
  (F1-correct: authenticated responder) — PASS.
- **arm4** raw-fallback REAL DOM: raw text visible, no action fired, no crash — PASS.
- **C2** multi-op JWT: no-cookie 401, guest forged answer dropped, operator answer →
  author={operator} + renderedBy={operator} (dl-13383 split intact) — C2_PROVEN.
- **operator-dismiss (NEW, dl-13527)**: authenticated operator dismiss → dismissed:true,
  author={operator} PRESERVED, answered:false, renderedBy={operator} — PASS. Direct F1 live proof.
- Isolation BEFORE/DURING/AFTER: has9999=0 has8000=0 non_loopback=0; zero residual
  ccr7 procs; prod 113263140666 pid 53346 untouched.

## Parity + tsc — SEQUENTIAL (Pete)
`d2-parity/D2-VERDICT.md`: candidate + baseline full suites run SEQUENTIALLY.
CANDIDATE 8 failed/6673 passed; BASELINE 8 failed/6580 passed. Failure-signature sets
BYTE-FOR-BYTE IDENTICAL (0 candidate-only, 0 baseline-only, 8 shared env floor).
Zero-new proven DIRECTLY — sequential run eliminated the r6 parallel-load flakes.
`tsc/TSC-DELTA-VERDICT.md`: tsc delta 0 (error identities identical; zero errors in F1/F3 files).

## Manifest
`SHA256SUMS.ccr7.txt` — SHA-256 over all evidence files (self-verifying).
