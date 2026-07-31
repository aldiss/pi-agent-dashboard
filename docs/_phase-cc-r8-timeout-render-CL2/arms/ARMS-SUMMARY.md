# §Arms — Actual-Surface Arms on the NEW Identity (CC-r8, CL2)

Staged identity: `build1-picker-cand-attr` @ **4937a8ea061f6779cde5faf1cf7c4d184a641a4f**
(NEW code commit — the timeout-render truthfulness fix). Client REBUILT (`npm run build`)
so the isolated dashboard serves the fixed renderers; verified the served bundle
(`assets/index-CC6tMvGC.js`) contains "No response". Every arm labeled with this hash.

Isolated dashboard: candidate worktree server, temp HOME, scratch ports 8157/8158,
loopback-listen-guard, multi-op (requireBrowserAuth, operatorUsers:["operator"], secret),
spawns pinned to :8158. Launcher WT=candidate — NEVER prod, NEVER build1-comms-prod-wt.

## Arms (all PASS)

### arm2 — A1-live REAL DOM MOUNT + the dl-13559 DOM ASSERTION (the headline)
`arms/arm2/result.json` A1_LIVE_CONTRAST_PROVEN. The operator browser mounts the real
dialog → fires the real prompt_rendered ACK → renderedBy. NOT answered → 8s bus timeout
→ prompt_cancel → cancelInteractiveRequest → status "cancelled".
- Data layer receipt: delivered:true, rendered:true, timedOut:true, answered:false,
  renderedBy={operator}, author absent.
- **DOM layer (the fix): assert_dom_shows_no_response=true AND
  assert_dom_no_answered_in_terminal=true** — the mounted card visibly reads "No response"
  and does NOT contain "Answered in terminal" (the exact false string Pete caught in r7).
- Screenshot `arms/arm2/rendered-postTimeout.png` shows "Deploy Build-1 to production
  now?  No response". Contrast: never-rendered (no browser) → delivered:false, no renderedBy.

### arm1 — opt1 bijection (REAL DOM click)
`arms/arm1/result.json` PASS. returned == original[1], answered @ dashboard source.

### arm3 — malformed → invalid non-decision
`arms/arm3/result.json` PASS. invalid:true, answered:false, no "User responded:
undefined"; author={operator} (an authenticated operator submitted the malformed payload
— the responder, never a false answerer).

### arm4 — operator-visible raw-fallback (REAL DOM)
`arms/arm4/result.json` PASS. Raw question text visible, no action fired, no crash.

### C2 — multi-operator JWT (dl-13383 split intact)
`arms/c2/result.json` C2_PROVEN. no-cookie WS→401, guest forged answer dropped, operator
answer → author={operator} + renderedBy={operator}.

### operator-dismiss (dl-13527 author preserved)
`arms/operator-dismiss/result.json` PASS. Authenticated dismiss → dismissed:true,
author={operator} preserved, answered:false, renderedBy={operator}.

## Isolation proof
- ISOLATION-BEFORE/DURING/AFTER: iso dash (pid 58394) listens ONLY 127.0.0.1:8157/8158;
  has9999=0 has8000=0 non_loopback=0; residual_ccr8_sessions=0 after teardown; prod
  commit 113263140666 pid 53346 untouched throughout.
- loopback-guard.log + per-arm socket proofs.
