# §3 — Actual-Surface Arms on the NEW Identity (CC-r6, CL2)

Staged identity: `build1-picker-cand-attr` @ **3055f8bf90db10f33013e2dfcfd749d8c78bcb12**
(NEW commit — the D1 responder-attribution split). Every arm labeled with this hash
(`staged_head` in each result.json), NOT the prior `2e8df4c`/"worktree".

Isolated dashboard: candidate worktree server, temp HOME `/tmp/build1-ccr6-cand-8153/state`,
scratch ports 8153/8154, reclaim DISABLED, loopback-listen-guard (`--require`), 8s
ask_user timeout. Every spawned session pinned via `PI_DASHBOARD_URL=ws://localhost:8154`
→ bridge ISOLATION GUARD (no mDNS discovery, no auto-start) → dials ONLY the scratch
gateway. Launcher `WT=/Users/vdrobkov/build1-picker-cand-e0-wt` (NEW identity) — NEVER
the prod worktree, NEVER build1-comms-prod-wt.

## Arms (all PASS)

### arm3 — malformed → invalid non-decision (single-op)
`arms/arm3/result.json` — PASS:true. Live pi session called ask_user(select); a
malformed `prompt_response` (cancelled:false, NO answer) injected over the real /ws.
Receipt: `invalid:true, answered:false`. JSONL has NO "User responded: undefined".
D1: `assert_no_author:true` (malformed non-answer carries NO author). Socket:
has9999=false has8000=false.

### C2 — multi-operator JWT live auth (D1 author/renderedBy split)
`arms/c2/result.json` — C2_PROVEN:true. Config requireBrowserAuth:true,
operatorUsers:["operator"], secret. Real JWTs minted with the config secret.
- no-cookie WS upgrade → 401 REFUSED (`no_principal.assert_denied`)
- guest forged render+answer FIRST → dropped by the gate (`assert_guest_answer_did_not_win`,
  `assert_no_guest_answer`) — the guest's value NEVER won first-response
- operator RENDERED + ANSWERED (distinct value) → ACCEPTED. Receipt:
  `author={operator,isOperator:true}` (the ANSWERER) AND
  `renderedBy={operator,isOperator:true}` (the RENDERER) — D1 split fields, both present
  because the operator did both. `assert_author_is_operator` + `assert_renderedBy_is_operator`.
- Socket: has9999=false has8000=false.

### arm2 — A1-live rendered-vs-never (D1 renderedBy split, the CONTRAST proof)
`arms/arm2/result.json` — A1_LIVE_CONTRAST_PROVEN:true. Render ACK driven over the
real /ws via raw `prompt_rendered` (no chromium needed). Multi-op so the ACK carries
the server-stamped operator author.
- RENDERED-then-timeout: `delivered:true, rendered:true, answered:false, timedOut:true,
  source:__bus__, renderedBy={operator}` and **author ABSENT**. THIS is the D1 fix on
  the live surface: the operator who RENDERED is preserved in `renderedBy`; because
  nobody ANSWERED, `author` is absent. Pre-fix this receipt carried `author=operator`
  (falsely proving the operator answered a timed-out prompt).
- NEVER-rendered: `delivered:false, rendered:false, timedOut:true`, no renderedBy, no author.
- Sockets: rendered_clean=true never_clean=true.

## Isolation proof
- `arms/ISOLATION-BEFORE.txt` — scratch free, prod owns :9999/:8000 pre-launch.
- `arms/ISOLATION-DURING.txt` — iso dash (pid 35239) listens ONLY 127.0.0.1:8153/8154;
  all ESTABLISHED conns loopback (spawned bridges → :8154, voice sidecar :8765);
  has9999=0 has8000=0 non_loopback_conns=0.
- `arms/ISOLATION-AFTER.txt` — scratch free, zero residual ccr6 procs, prod commit
  113263140666 pid 53346 untouched.
- `arms/loopback-guard.log` — every listen FORCEd to 127.0.0.1 (incl. :8153 from 0.0.0.0).
- Per-arm socket proofs under `arms/<arm>/*-socket-proof.txt`.

## Note on scope
All three brief-required arms (A1-live, malformed, C2 multi-op) ran live end-to-end on
the NEW identity. arm2's render ACK was driven over the real /ws browser gateway via a
raw `prompt_rendered` message rather than a Playwright browser mount — the ms-playwright
chromium binary is not installed in this environment (cache absent). This exercises the
identical bridge→PromptBus→deriveReceipt surface (the ACK path the client would fire on
mount); only the DOM render of the dialog is not visually screenshotted. Disclosed
honestly; no result faked.
