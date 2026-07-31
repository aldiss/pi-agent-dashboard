# §F2 — Actual-Surface Arms on the NEW Identity (CC-r7, CL2)

Staged identity: `build1-picker-cand-attr` @ **7fc75b566ef51a70825cf429ffee433498961f06**
(NEW FIX commit — F1 dismiss-actor preserve + F3). Every arm labeled with this hash
(`staged_head` in each result.json).

Isolated dashboard: candidate worktree server, temp HOME `/tmp/build1-ccr7-cand-8155/state`,
scratch ports 8155/8156, reclaim DISABLED, loopback-listen-guard (`--require`), 8s
ask_user timeout, MULTI-OP config (requireBrowserAuth, operatorUsers:["operator"], secret).
Spawns pinned via `PI_DASHBOARD_URL=ws://localhost:8156` → bridge ISOLATION GUARD (no
mDNS, no auto-start). Launcher `WT=/Users/vdrobkov/build1-picker-cand-e0-wt` — NEVER prod,
NEVER build1-comms-prod-wt. Chromium: chromium-1217 (installed this round for real DOM).

## Arms (all PASS)

### arm1 — opt1 bijection (REAL DOM click)
`arms/arm1/result.json` PASS. Real browser navigates to /session/:sid, dialog mounts,
clicks option[1] → returned == original[1] (bijection), selectedIndex==1,
receipt answered @ dashboard source, 3 distinct labels. Screenshots preclick/postclick.png.

### arm2 — A1-live REAL DOM MOUNT + SCREENSHOT (the Pete dl-13527 requirement)
`arms/arm2/result.json` A1_LIVE_CONTRAST_PROVEN. The operator browser (authenticated
via pi_dash_token cookie) mounts the real InteractiveUiCard → fires the REAL
prompt_rendered ACK → server stamps operator author → renderedBy. NOT answered → 8s bus
timeout.
- RENDERED: dialog_mounted=true (3 real labels visible), receipt delivered:true,
  rendered:true, timedOut:true, answered:false, renderedBy={operator}, author ABSENT.
  Screenshots `rendered-mounted.png` (dialog mounted) + `rendered-postTimeout.png`.
- NEVER-rendered (no browser): delivered:false, rendered:false, no renderedBy, no author.
Real-DOM, not raw /ws injection (the r6 gap is closed).

### arm3 — malformed → invalid non-decision
`arms/arm3/result.json` PASS. Operator /ws injects cancelled:false + NO answer →
receipt invalid:true, answered:false, JSONL NO "User responded: undefined".
D1/F1 note: the receipt carries author={operator} — CORRECT post-F1: the operator
authenticated-submitted the (malformed) response, so the gateway server-stamps the
operator responder; a malformed submission never reads as an ANSWER (answered:false).

### arm4 — operator-visible raw-fallback (REAL DOM)
`arms/arm4/result.json` PASS. Real browser mounts a real ask whose raw question text is
VISIBLE in the DOM, NO action auto-fired (no answered receipt, no "User responded"), no
page crash. Screenshot `raw-visible.png`. Scope note: the translate/lint door is not
staged on this surface (documented boundary) — the render-path readable-raw is what is drivable.

### C2 — multi-operator JWT live auth (dl-13383 split intact)
`arms/c2/result.json` C2_PROVEN. no-cookie WS → 401; guest forged render+answer dropped
(never won first-response); operator answer → receipt author={operator,isOperator}
(ANSWERER) + renderedBy={operator} (RENDERER) — the dl-13383 split still holds under F1.

### operator-dismiss (NEW, dl-13527) — the direct F1 live proof
`arms/operator-dismiss/result.json` PASS. Authenticated operator RENDERS (real ACK) then
DISMISSES (prompt_response cancelled:true, no answer). Gateway server-stamps the operator
author on the dismiss. Receipt: dismissed:true, author={operator,isOperator} PRESERVED
(pre-fix the answerPresent gate dropped it), renderedBy={operator}, answered:false. This
is F1 on the true surface.

## Isolation proof
- `arms/ISOLATION-BEFORE.txt` — scratch 8155/8156 free, prod owns :9999/:8000.
- `arms/ISOLATION-DURING.txt` — iso dash (pid 47159) listens ONLY 127.0.0.1:8155/8156;
  all ESTABLISHED conns loopback (spawned bridges → :8156, voice sidecar :8765);
  has9999=0 has8000=0 non_loopback=0.
- `arms/ISOLATION-AFTER.txt` — scratch free, residual_ccr7_sessions=0, prod commit
  113263140666 pid 53346 untouched.
- `arms/loopback-guard.log` — every listen FORCEd to 127.0.0.1.
- Per-arm socket proofs `arms/<arm>/*-socket-proof.txt`.

## Note on a harness fix mid-run
The fixed-tag arms (arm1/arm3/arm4) initially reused a prior run's session dir (same
tag → same cwd → stale sid), which made re-runs find no fresh prompt_request. Fixed by
making every arm's tag unique per run (Date.now() suffix) — a harness correction, not a
product change. arm2/c2/operator-dismiss already used unique tags. All six then passed.
