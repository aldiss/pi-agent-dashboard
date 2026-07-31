# CC-r8 — Timeout Rendered Truthfully: "No response", not "Answered in terminal" (dl-13559)

Pete BLOCK dl-13559, amended ON TOP of 7fc75b5 (r7 commits 7fc75b5 + e6afee9 preserved).
NO push / deploy / materialize / operator-solicitation. Zero AI attribution. No scope
expansion. build1-comms-prod-wt never touched. Prod (:8000/:9999, pid 53346,
113263140666) untouched throughout.

- Candidate worktree: `/Users/vdrobkov/build1-picker-cand-e0-wt`, branch `build1-picker-cand-attr`
- NEW CODE commit: **4937a8ea061f6779cde5faf1cf7c4d184a641a4f**
- Baseline (parity ref, read-only): `113263140666dee39721e2ef17e1db40a366cdc1`

## The defect (caught by the r7 real-DOM arm2)
The receipt was truthful at the DATA layer (timedOut:true, answered:false) but the
CLIENT rendered a bus timeout as "Answered in terminal" — a false claim of a TUI answer.
Chain: `useMessageHandler` `case "prompt_cancel"` → `dismissInteractiveRequest` → status
"dismissed" → all six renderers map "dismissed" → "Answered in terminal". The enum
already had a distinct "cancelled" status the path ignored.

## Fix (`fix/code-fix.diff`)
1. `event-reducer.ts:1047` — add `cancelInteractiveRequest`, sister of
   `dismissInteractiveRequest`, identical except sets status "cancelled" on the request
   and the message args. Pending-only. Exported.
2. `useMessageHandler.ts:696` — route `case "prompt_cancel"` (bus timeout — nobody
   answered) to `cancelInteractiveRequest`. `case "prompt_dismiss"` (genuine TUI answer)
   stays on `dismissInteractiveRequest`; `ui_dismiss` unchanged.
3. All six renderers — status "cancelled" → "No response" (was "Cancelled"; Generic
   gained the case). "dismissed" still → "Answered in terminal".
4. `prompt-bus.ts` — remaining ANSWER-only comments corrected to the RESPONDER semantic
   (comments only, no logic change).

## RED→GREEN tests (`fix/r8-tests-RED-prefix.log` = 4 fail pre-fix; `...GREEN-postfix.log` = 138 pass)
- reducer: `event-reducer.test.ts:1166` ([able-to-fail] cancel → "cancelled") + no-op-unless-pending + dismiss/cancel distinctness.
- handler: `useMessageHandler.prompt-cancel-vs-dismiss.test.tsx:86` ([able-to-fail]
  prompt_cancel → "cancelled") + `:96` (prompt_dismiss → "dismissed" preserved).
- renderer: `SelectRenderer.test.tsx:127` + `GenericInteractiveRenderer.test.tsx:26`
  ([able-to-fail] cancelled → "No response" and NOT "Answered in terminal"; dismissed preserved).
- Updated the two pre-existing renderer tests (InputRenderer, MultiselectRenderer) that
  pinned the old "Cancelled" label → now assert "No response" + reject "Answered in terminal".
Full client suite: only the 7 known ChatView env-flakes remain, zero new failures
(`fix/client-full-suite-only-chatview-flakes.log`).

## Arms — all six fresh on the NEW identity, client REBUILT (`arms/ARMS-SUMMARY.md`)
Isolated candidate dashboard (scratch 8157/8158, multi-op, loopback-guard). Client
rebuilt so the served bundle carries the fix.
- **arm2** REAL DOM: after the bus timeout the mounted card shows "No response" and does
  NOT contain "Answered in terminal" (assert_dom_shows_no_response=true,
  assert_dom_no_answered_in_terminal=true). Screenshot `arms/arm2/rendered-postTimeout.png`
  reads "Deploy Build-1 to production now?  No response". Data receipt still truthful.
- arm1 bijection, arm3 malformed, arm4 raw-fallback, C2 multi-op split, operator-dismiss
  author-preserved — all PASS. Socket-proven zero :9999/:8000; prod untouched.

## Parity + tsc — SEQUENTIAL (Pete)
See `d2-parity/D2-VERDICT.md` + `tsc/TSC-DELTA-VERDICT.md`.

## Manifest
`SHA256SUMS.ccr8.txt` — SHA-256 over all evidence files (self-verifying).
