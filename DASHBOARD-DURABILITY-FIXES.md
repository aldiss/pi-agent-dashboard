# DASHBOARD-DURABILITY-FIXES.md — make resurrect / rebridge / row-hygiene durable

**Driver:** DisasterReplay. **Date:** 2026-06-30. **Principle:** enforce safety by **CODE, not discipline** (the isolation guard is the model: a pinned env mechanically prevents the cross-wire that discipline alone kept missing).

Status legend: **SHIPPED** (in un-end v2, HELD for deploy) · **CANDIDATE** (proposed here) · **PENDING-EVIDENCE** (waits on an experiment).

---

## Fix-1 — `PI_DASHBOARD_URL` pin as a durability PRIMITIVE (not just a fixture) — SHIPPED (server) / promote
**Failure it closes:** an orphaned/respawned pi auto-discovers a dashboard via mDNS and can bind a stale/wrong one (dl-2942/2976 mDNS cross-wire). 
**Mechanism:** `server-auto-start.ts` → `if (config.pinnedUrl) return {}` — when `PI_DASHBOARD_URL` is set the bridge does NO discovery / NO auto-start for the session lifetime. 
**Durability rule:** make `PI_DASHBOARD_URL=ws://localhost:<pi-port>` a **non-negotiable env on every replay/respawn server.** 
**Evidence:** held across all **8 E5 server restarts** — every respawn bound the test gateway, prod untouched.

## Fix-2 — pin the RESURRECT RESPAWN to the spawning server's own URL — **PROVEN (un-end Fix-2(a); HELD for deploy)**
**Failure it closes:** the v2 resurrect respawn inherits the server's env (`buildSpawnEnv` starts from `process.env`); in single-dashboard prod it auto-discovers the one dashboard (fine), but it is **NOT robust against the multi/stale-dashboard case** — a resurrected session could cross-wire to the wrong dashboard and appear bridgeless on the intended one (Mechanism-B). 
**Fix (BUILT + real-e2e GREEN, UnendFinisher `cc-unend-pin`):** the resurrect endpoint auto-injects `PI_DASHBOARD_URL=ws://localhost:<server's own runtime pi-port>` (read from `piGateway.address()`) onto the respawn — **env-INDEPENDENT**, so a resurrected session can never cross-wire even when the server env carries no pin. 
**Proof:** on a separate `:8004/:9995` harness, with ALL FOUR dashboards (`:8000/:8001/:8002/:8004`) advertising mDNS, the respawn socket stayed `->[::1]:9995 (ESTABLISHED)` = its own server, NEVER migrated; resurrect 200 `verified:true` in 4.8s. 
**b1-floor vs (a)-durable:** setting `PI_DASHBOARD_URL` in the server env (Fix-1) achieves the same OUTCOME but requires the operator to set it right on EVERY deploy; (a)'s code guarantees it WITHOUT that, on every resurrect. 
**Justification:** prod ALREADY satisfies the cross-wire preconditions (`dns-sd -B _pi-dashboard._tcp` shows `:8000` + `:8001` advertising; isolated HOME does NOT constrain mDNS), so the fix is warranted independent of the wide-open test. **Status: HELD for deploy** with the rest of un-end v2.

## Fix-3 — health-gate TRIPLE: `pages_available%` + `swapout-RATE` + `jetsam-kill-count` — CANDIDATE (deprecate free-pages)
**Failure it closes:** a `pages_free`-vs-`pages_available` metric conflation recurred **4× tonight** (Lane). free-pages (~0.2%) misread as "jetsam-edge" when `pages_available` (40%+) is healthy → risks panic-reaping / mis-attributing an incident to "memory" (wrong fix). macOS keeps free near-zero as file-cache. 
**Fix:** every dashboard/health-gate + every memory-read tool reads the **dl-1899 triple** (`pages_available%` + `swapout-RATE` + `jetsam-kill-count`); **deprecate `pages_free`-alone.** 
**Evidence:** Lane manifest §7#6 `audit-lane-process.md`; this run's gate ran on R-runnable + swapout-rate (never tripped a false pause once corrected).

## Fix-4 — bridge-disconnect REASON field + persisted pi-gateway stdout — CANDIDATE (closes G1/G4)
**Failure it closes:** today the dashboard records "no bridge" 502 but NOT why (heartbeat-timeout vs cross-wire vs process-gone), and gateway logs are not persisted → the 18:21 bridge-drop reason + kill-trigger are **unprovable from state**. 
**Fix:** (a) persist gateway stdout to a rotating file; (b) add a **`bridge_disconnect_reason`** field to the session row (`heartbeat-timeout` / `cross-wire` / `process-gone` / `clean-shutdown`). Turns the next bridgeless event into a diagnosis, not a guess — and lets the dashboard auto-route Mechanism-A vs B.

## Fix-5 — external off-tmux wipe-monitor — CANDIDATE (closes G1)
**Failure it closes:** the 18:21 pane-wipe was a per-session-kill inside a SURVIVING tmux server; nothing OUTSIDE recorded who issued the kills. 
**Fix:** a tiny off-tmux daemon that logs per-session-kill events + their origin (signal source / kill-session caller) from outside the tmux server being wiped. Makes a kill-session-sweep vs mesh-reset decidable next time.

## Fix-6 — row hygiene: demote-reaper + authoritative-hide + name-sync — EVIDENCE IN (E2)
**Failure it closes (now OBSERVED on the test dashboard, E2):** dead sessions display `active` and rows accumulate (the 324-row / ghost reality). Three concrete root causes proven by code-read + live probe:
1. **No demote-on-death.** `session-bootstrap` restores `status` from the last on-disk JSONL event; `resolveDriverLiveness` only **PROMOTES** ended→live — it never **DEMOTES** stale-active→ended when the process is gone (kill-0 fails). → a truly-dead session shows `active` until something reaps it.
2. **`hide` is display-only.** `POST /api/session/:id/hide` sets `hidden:true`, but `/api/sessions` does NOT server-side-filter `hidden` (no `WHERE hidden=false`) — it's a client render flag; the row stays in the API list.
3. **Name-sync unenforced.** No server rename endpoint → `pi-rename` vs raw-rename consistency is not checked (raw rename FALSE-GREENs; see F5).
**Fix:** (a) add a **demote-reaper** — on `resolveDriverLiveness` failure (registry-miss ∧ kill-0-dead), demote the row active→ended/`dead`, not just refrain from promoting; (b) make **hide authoritative** OR add a server-side `hidden` filter so a hidden row truly leaves the operational list; (c) enforce **name-sync via `pi-rename`** with a meta+registry consistency check that CATCHES a raw-rename divergence. 
**Status:** root causes EVIDENCED (E2); fixes CANDIDATE.

## Fix-7 — verify-gate FAIL-CLOSED is the durability cornerstone — SHIPPED (keep + extend)
**What it is:** the un-end v2 resurrect runs a 5-assertion gate and **refuses to report success** if any assertion can't be OBSERVED (process-alive / bridge-connected / controllable / writable / model-changeable). It returned HTTP 503 on a real target rather than false-green (RESULT-2). 
**Durability value:** a restore that *says* it worked but didn't is worse than a loud failure. **Keep fail-closed; extend the same gate to every restore path** (not just resurrect). The deliberate failed-restore tests F1–F5 are the proof it stays loud across failure modes.

---

## Priority / sequencing
1. **Fix-2 (pin resurrect-respawn)** + **Fix-7 (keep fail-closed)** — directly harden the un-end path; smallest surface; pair with the deploy.
2. **Fix-3 (health-gate triple)** — cheap, stops a recurring mis-diagnosis class; tool-wide.
3. **Fix-4 + Fix-5 (instrumentation)** — make the NEXT crash diagnosable (closes G1/G4); the highest-leverage "never-again" investment.
4. **Fix-6 (row hygiene)** — confirm via E2, then ship the reaper/name-sync correctness fix.
5. **Fix-1 (pin primitive)** — already the norm for the test harness; codify it as the canonical replay-server invariant.

---

## Fix-8 → `tmux / pi TUI resize regression` — **DEFERRED to Faye/process-miner (operator-routed); dashboard hypothesis SUPERSEDED**
**Operator clarification (2026-06-30, via Alice):** the operator views sessions in the **pi TUI**, NOT the dashboard. The earlier dashboard/capture-pane root-cause framing is therefore **SUPERSEDED + out-of-scope** — do NOT treat it as the cause. The operator does not accept the current explanation and has routed **Faye (process-miner) to investigate directly**; the durable fix WAITS for that evidence.
**Possibly-relevant OBSERVED facts (unconfirmed as the cause — inputs for Faye, NOT a root-cause claim):**
- Spawn paths hard-code a fixed window size: `cc-launch` `-x 200 -y 50` (`:82`); `spawn-driver` `-x 220 -y 50` (`:379,404`) — one-off `resize-window` only.
- `-L pi` socket has no `window-size` / `aggressive-resize` set.
- These MAY or MAY NOT relate to the pi-TUI resize behavior — Faye's direct evidence decides.
**SUPERSEDED hypothesis (recorded for transparency, NOT asserted):** "dashboard renders via capture-pane → clientless detached session can't auto-size → dashboard must drive `resize-window`." This assumed dashboard-viewing; the operator views in pi TUI → superseded.
**Interim mitigation (DONE by Alice):** resized live pi/CC sessions to 205x64 + `aggressive-resize on`.
**Status:** DEFERRED — awaiting Faye/process-miner evidence; NO durable fix asserted until then. Retained here only as an unconfirmed cross-reference, not a dashboard-durability item.

---

## Deploy-surfaced durability findings (un-end landing, 2026-06-30) — confirmed during the live deploy
The un-end v2 prod deploy + step-6 surfaced THREE durability gaps (all read-only confirmed; the un-end fix itself is owner-gated under Joan — these are the durability-family records):

**Fix-9 — launchd plist PATH must include the runtime-tool bins (deploy-env durability).** The prod dashboard's launchd plist `EnvironmentVariables.PATH = /usr/local/bin:/usr/bin:/bin` — MISSING `/opt/homebrew/bin` where `tmux` lives (own-hand: `tmux` ONLY at `/opt/homebrew/bin/tmux`; prod pid 63454 env + the plist both confirm). RESULT: the §19 `strategy:tmux` respawn's `isTmuxAvailable()` (= `which tmux` under the launchd PATH) returns false → silent headless fallback → the v1 `--mode rpc` crash-form in PROD. FIX: the dashboard launchd plist PATH must include `/opt/homebrew/bin` (+ any runtime-tool bins). Composes with W1a (the plist-transform can carry the PATH hardening). This is the CLASS of "deploy looked done but the host env silently degraded it" the disaster-replay is about.

**Fix-10 — fail-loud when a requested interactive strategy can't resolve its tool (no silent headless fallback).** `selectMechanism` currently SILENTLY falls back to headless `--mode rpc` when `strategy:tmux` is requested but `isTmuxAvailable=false`. The headless form is the v1 crash-form (the exact thing un-end v2 replaced). FIX: a `strategy:tmux` (or any interactive) request that can't resolve its tool should FAIL-LOUD (503 / surfaced error), NOT silently become the crash-form — same no-silent-degradation discipline as the un-end verify-gate + the Fix-3 health-gate-triple. (Alice d22-enforcement; CC fast-follow B.)

**Fix-11 — harden ALL default-headless pi-native resume/spawn paths.** The silent-headless class is BROAD: `/api/session/:id/resume` (session-api.ts:703), prompt-auto-resume (session-action-handler.ts:~226, `handleSendPrompt` ended-branch), `spawn_new_session` (event-wiring.ts:887), fork-degrade (session-api.ts:666) ALL spawn with `config.spawnStrategy` (default `headless` → `--mode rpc`). un-end v2 fixed ONLY `/resurrect`'s `doRespawnContinue`. FIX: route every pi-native session-RESUME path through the §19 interactive form (strategy:tmux + pin) — or fail-loud — so none silently default to the headless crash-form on a real session-resume. (CC fast-follow C.)

**Fix-11 AMEND (5th path) — `handleHeadlessReload` (session-action-handler.ts).** Pete strict-spec QA + two-key architect (Bert concur, Alice harden) found a 5th session-RESUME path the original 4-path inventory missed: the headless `/reload` handler respawned `mode:"continue"` + existing `sessionFile` with `strategy:"headless"` = the `--mode rpc` crash-class on a session-file replay. FIX: respawn via `buildInteractiveResumeOptions` (strategy:tmux + requireInteractive + pin + agentName) — same §19 form + fail-loud as the sibling prompt-auto-resume. EXPLICIT no-headless-register (Bert): the detached interactive respawn is NOT tracked in `headlessPidRegistry` — that registry is the routing key for `shouldInterceptReload`, so a converted session's next `/reload` routes to the TUI `/__dashboard_reload` path, NOT back to `handleHeadlessReload` (item-4 routing coherence, self-consistent — no caller change). Kill-path (item-3): `handleHeadlessReload` is reachable ONLY when `getPid !== undefined` = a headless predecessor, so `killBySessionId` (kills registry pids) always covers it; an interactive predecessor is structurally unreachable here. Test flipped: `session-action-handler-headless-reload.test.ts` now asserts the §19 form (no `strategy:"headless"`) + NOT-headless-registered + fail-loud `INTERACTIVE_UNAVAILABLE`. Amend commit on `feat/dashboard-durability-integration`.

**Provenance:** surfaced during the operator-authorized un-end deploy 2026-06-30; root cause converged via UnendFinisher (empirical) + Alice (own-hand) + DisasterReplay (read-only confirm + the headless-source hunt). The un-end retry (PATH fix + 2168/2169 cleanup) is owner-gated under Joan; Fix-10/11 are d22-reviewed CC fast-follows.

---

## Follow-up FU-1 — baseline pre-existing arch-guard + client-test debt (NOT the 4 fixes)

**Status:** SEPARATE follow-up (Joan decision-b, 2026-07-01) — flagged, NOT fixed in the durability-integration. Pre-existing prod debt, not a regression, outside the operator-directed 4-fix scope. Built + committed on branch `feat/dashboard-durability-integration` (worktree `/private/tmp/dashboard-integration`), commits Fix-10 `c2a6c9c` / Fix-11 `2014273` + `bfb7006` (no-crash guard) / W1b `2ca70f5` / W4 `b4aa286`.

**Finding.** Running the FULL suite (server+shared+client) on integration baseline `a5fe3e6` surfaced failures our SERVER-scoped baseline verification missed:
- **2 shared architecture-guard failures**: `no-direct-process-kill` flags `driver-liveness.ts:57 process.kill(pid, 0)` (un-end); `no-direct-child-process` flags `cc-pane-liveness.ts:21 execFileSync` (row-hygiene) — both outside the `packages/shared/src/platform` allowlist.
- **7 client ChatView render-test failures** (`ChatView.test.tsx` + `ChatView.streaming-text-flush.test.tsx`) — pre-existing/environmental.
- **1 worktree-manager** (known-environmental nested-worktree branch-resolution).

**Airtight pre-existence proof (DOUBLE, independent):**
1. **DisasterReplay live-run** at clean baseline `a5fe3e6` (WITHOUT the 4 fixes): both guards FAIL (`cc-pane-liveness.ts:21` + `driver-liveness.ts:57`, 2 failed/2).
2. **Bert merge-base check**: `process.kill` is in `driver-liveness.ts` at the pure merge-base `dda5919` (= prod's HEAD, predating BOTH branches) = pure prod debt. Allowlist byte-identical baseline→HEAD.
→ The debt predates the 4 fixes AND the merge — pre-existing prod code.

**Investigation note (Joan's analysis, Bert-concurred) — real-debt vs false-positive:**
- `driver-liveness.ts process.kill(pid, 0)` is the canonical LIVENESS-PROBE idiom (not an actual kill) → likely LEGIT; the guard may be over-strict.
- `cc-pane-liveness.ts execFileSync` likely runs tmux/ps for pane-liveness → likely LEGIT; may just need an allowlisted platform wrapper.

**Enforcement-intent meta-question (Joan):** these violations run in prod fine → the arch-guards are either advisory or not enforced on prod code. The follow-up clarifies enforcement intent (advisory vs blocking; allowlist the liveness-probe idioms vs wrap them).

**Lesson banked (Joan + Bert):** baseline verification must state SCOPE explicitly and run the FULL suite (server+shared+client), not server-scoped. All three verifiers (DisasterReplay + Bert + Joan) ran server-only and missed ~9 pre-existing failures. Bert self-corrected `dl-3686` "full baseline PASS" → `dl-3707` "SERVER-scoped PASS". The merge d22 stands (debt in both branches = pre-existing, merge faithful, not a merge-regression).
