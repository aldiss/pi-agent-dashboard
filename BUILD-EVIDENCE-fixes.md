# BUILD-EVIDENCE — Dashboard durability follow-on fixes (Fix-10 · Fix-11 · W1b · W4)

Session: `cc-dashboard-fixes` · Supervisor: DisasterReplay · Baseline: `a5fe3e6` on `feat/dashboard-durability-integration`.
Harness: `:8002` dashboard / `:9997` pi-gateway, isolated `HOME=/tmp/unend-e2e-home`, real 11.9 MB seed
`019edfad-6559-7671-affb-04e0b2a683c8` (name `Pete`, cwd `/private/tmp/unend-e2e-cwd`).

Baseline regression floor (the 96/96 the brief names, measured here): **135/135** across
`resurrection-verify` + `session-api` + `no-model-on-resume` + `session-hygiene` + `cc-pane-liveness` + `process-manager`.

Anchor note (all fixes): the brief's `src/server/**` paths are the pre-monorepo layout. The tree is a
workspace monorepo — real paths are `packages/server/src/**`, `packages/shared/src/**`. Semantics matched 1:1.

---

## Fix-10 — fail-loud when an interactive strategy can't resolve its tool

**Bug.** `chooseMechanism`/`selectMechanism` silently falls back to `headless` when `strategy:tmux` is
requested but tmux is unavailable. Headless `--mode rpc` is the v1 crash-form on large logs — the exact
form un-end v2 replaced. The prod PATH-miss (step-6) hit this.

**Fix (own-hand).**
- `packages/shared/src/browser-protocol.ts` — new `SpawnFailureCode` member `INTERACTIVE_UNAVAILABLE`.
- `packages/server/src/process-manager.ts` —
  - `SessionOptions.requireInteractive?: boolean` (opt-in; set only by real session-RESUME paths).
  - pure exported guard `interactiveResolutionFailed(mechanism, requireInteractive)` — `true` iff
    `requireInteractive && mechanism==="headless"`.
  - fail-loud gate in `spawnPiSession`, right after `chooseMechanism`: returns
    `{success:false, code:"INTERACTIVE_UNAVAILABLE", …}` instead of dispatching the headless spawn.
- `packages/server/src/session-api.ts` — the `/resurrect` `doRespawnContinue` respawn now passes
  `requireInteractive:true` (it already forced `strategy:"tmux"` + pin + agentName — this closes the
  silent-degradation hole under it).

**Design note surfaced to DisasterReplay:** `requireInteractive` is scoped to real session-RESUME (loads an
existing `--session <file>` = the large-log crash risk). Fresh spawns (no sessionFile) intentionally leave it
unset → the graceful headless fallback still stands for tmux-less hosts. This is the defensible reading of
"harden the resume/spawn paths"; it does NOT force tmux on every `+ Session` click.

### Test (unit) — `packages/server/src/__tests__/fail-loud-interactive-resolve.test.ts` — 7/7 green
Pure guard truth-table (headless+require→refuse; tmux/wt/wsl-tmux+require→pass; headless w/o require→pass) +
`spawnPiSession` integration with an injected no-tmux `ToolResolver`: `requireInteractive` → refuses with
`INTERACTIVE_UNAVAILABLE` and the message is NOT "spawned headless"; fresh spawn (no require) → NOT refused.

### Falsifiable harness acceptance (both branches proven on :8002)

**Branch A — tmux AVAILABLE (normal PATH).** `POST /api/session/019edfad…/resurrect`:
```
HTTP 200  {"success":true,"data":{"resurrected":true,"mode":"respawn","verified":true}}
```
Spawned pane command (captured from the default-socket `pi-dashboard` tmux):
```
cd /private/tmp/unend-e2e-cwd && PI_AGENT_NAME=Pete PI_DASHBOARD_URL=ws://localhost:9997 \
  pi --name Pete --session …019edfad….jsonl
```
→ exact §19 form: `--name Pete`, `--session`, **NO `--mode rpc`**, **NO `--model`**, pin = the test gateway
`ws://localhost:9997` (isolation guard — never prod :9999). Gate did NOT fire when tmux resolves. Spawn
cleaned up after capture (kill pid + window).

**Branch B — tmux UNAVAILABLE.** Restarted :8002 with a shim PATH
(`/tmp/fix10-notmux-shim-*` symlinks node/pi/npm/git but NOT tmux; `useLoginShell` defaults off, so the strip
genuinely hides tmux). Same resurrect on the same case-3 seed:
```
HTTP 500  {"success":false,"error":"interactive session-resume required but no interactive terminal
           (tmux / Windows Terminal / WSL-tmux) could be resolved on this host. Refusing to silently
           spawn the headless `--mode rpc` form (the crash-form on large session logs). …"}
```
Falsifiable check — the point of the fix — **NO headless spawn happened**:
```
ps → NO pi with `--mode rpc` + 019edfad   (">>> NO headless --mode rpc spawn — refusal held")
ps → NO pi process carrying the seed file  (">>> clean refusal")
```
The silent degrade-to-crash-form did NOT occur; the endpoint failed loud instead.

### Regression after Fix-10: **142/142** (135 baseline + 7 new) + 25/25 shared spawn-mechanism/code suites. Zero regressions.

---

## Fix-11 — harden ALL default-headless pi-native session-RESUME paths

**Bug.** un-end v2 hardened ONLY `/resurrect`'s `doRespawnContinue`. Every OTHER path that resumes an
existing `--session <file>` spawned with `config.spawnStrategy` (default headless → `--mode rpc` = the v1
crash-form on large logs):
- REST `POST /api/session/:id/resume`  — `session-api.ts` (was ~703)
- prompt-auto-resume (ended-branch)    — `session-action-handler.ts` `handleSendPrompt` (was ~223)
- WS `handleResumeSession`             — `session-action-handler.ts` (was ~364, the primary Resume button)

**Fix (own-hand).**
- New `packages/server/src/resume-spawn-options.ts` — single source of the §19 resume shape:
  - `buildInteractiveResumeOptions({sessionFile, mode, agentName?, pinDashboardUrl?})` → always
    `strategy:"tmux"` + `requireInteractive:true` (composes with Fix-10 → fail-loud, never silent headless),
    identity + pin included only when provided. NEVER a `model` field.
  - `resolvePinDashboardUrl(piGateway, serverPiPort?)` — prefers the live bound socket
    (`piGateway.address()`), falls back to the runtime port; never `loadConfig().piPort`.
- Converted all THREE real-resume sites to the builder (continue + fork). Identity = `session.name`; pin =
  the spawning server's own gateway.

**Anchor-mismatch surfaced (as the brief asked).** The brief lists `spawn_new_session` (event-wiring) and
fork-degrade (session-api + session-action-handler) as resume paths. On inspection **both are FRESH spawns
with NO sessionFile** — they replay no large log, so they CANNOT hit the headless crash-form the hardening
targets. Converting them would regress fresh-spawn on tmux-less hosts (a `+ Session` click would fail-loud
with no tmux). I left them on `config.spawnStrategy` and added explicit `Fix-11 scope note` comments at each
so the d22/QA gates see the exclusion is deliberate, not missed. This matches the fix's own wording ("route
every pi-native session-**RESUME** path"). **Flagging for DisasterReplay:** if the intent was to also force
§19 on fresh spawns, that's a one-line change per site — but it changes fresh-spawn UX on tmux-less hosts.

### Test (unit) — `packages/server/src/__tests__/harden-headless-resume-paths.test.ts` — 9/9 green
Builder §19-shape (continue/fork → tmux + requireInteractive; identity+pin included/omitted correctly; NEVER
a model field); pin resolver (live socket > config port > undefined); **structural repo-lint** — asserts
`session-api.ts` + `session-action-handler.ts` both route through `buildInteractiveResumeOptions` (fails loud
if a resume site reverts to a raw `config.spawnStrategy`). Sister to `no-model-on-resume`'s grep-lint, which
also stays green (the builder emits no `--model`).

### Falsifiable harness acceptance (both branches proven on :8002, against the 11.9 MB seed)

**tmux AVAILABLE.** `POST /api/session/019edfad…/resume {"mode":"fork"}`:
```
HTTP 200  {"success":true,"data":{"message":"Pi session spawned in tmux (new window)"}}
```
Spawned pane command:
```
cd /private/tmp/unend-e2e-cwd && PI_AGENT_NAME=Pete PI_DASHBOARD_URL=ws://localhost:9997 \
  pi --name Pete --fork …019edfad….jsonl
```
→ §19 form: `--name Pete`, `--fork <11.9 MB seed>`, pin `:9997`, **NO `--mode rpc`**, **NO `--model`**. Before
Fix-11 this site emitted `pi --mode rpc --fork …` (the crash-form). Spawn cleaned up after capture.

**tmux UNAVAILABLE** (shim PATH, tmux stripped). Same REST fork:
```
HTTP 500  {"success":false,"error":"interactive session-resume required but no interactive terminal … 
           Refusing to silently spawn the headless `--mode rpc` form …"}
ps → NO headless spawn — refusal held (GOOD)
```
The Fix-10 guard composes through the shared builder: a resume that can't resolve tmux fails loud instead of
silently degrading.

### Regression after Fix-11: **155/155** (142 + 9 new + 4 spawn-handler) + **60/60** resume/handler suites
(incl. `auto-resume.test.ts` which exercises the converted `handleSendPrompt`). Zero regressions.

---

## W1b — `bridge_disconnect_reason` field (ROOT-CAUSE Gap #4)

**Closes.** The dashboard recorded "no bridge" (502) but never WHY (heartbeat-timeout vs cross-wire vs
process-gone vs clean-shutdown). The liveness display lied three times in one night (Cartographer "down",
Joan `:9999=0`, UnendFinisher "stuck") — an undiscriminated app-registration flap vs a TCP-stable busy bridge.

**Anchor-mismatch surfaced (as the brief asked).** The brief calls `onDisconnect` "wired with no reason". In
fact **`onDisconnect` had ZERO consumers anywhere** — a fully dead hook (`grep` confirmed: declared in
pi-gateway, assigned nowhere). So W1b both threads the reason AND wires a fresh consumer.

**Fix (own-hand).**
- `packages/shared/src/types.ts` — `BridgeDisconnectReason` enum
  (`heartbeat-timeout|cross-wire|process-gone|clean-shutdown|unknown`); `unknown` mandatory + fail-loud. Two
  new `DashboardSession` fields: `bridgeDisconnectReason`, `bridgeDisconnectAt`.
- `packages/shared/src/bridge-disconnect-classifier.ts` — pure `classifyBridgeDisconnect(signals)`.
  Precedence: cross-wire > clean-shutdown > heartbeat-timeout > process-gone > unknown. Never blank.
- `packages/server/src/pi-gateway.ts` — `onDisconnect` signature → `(sessionId, reason)`; gathers signals at
  the `ws.on("close")` origin (close code, ping-miss count ≥ threshold, pid kill-0, cross-wire displacement)
  and classifies. Cross-wire displacement tracked via a `crossWiredSockets` set populated when a newer
  registration displaces a still-open socket for the same session id.
  - **Bug found + fixed mid-build (harness caught it):** the first cross-wire attempt mis-read as
    `clean-shutdown`. Root cause — a bridge whose FIRST message is `session_register` hits the
    `!currentSessionId` identity block, which did `connections.set(sid, ws)` BEFORE the register block's
    displacement check ran, masking the prior socket. Fix: detect displacement at BOTH entry points (the
    first-message identity block AND the session_register block), capturing the prior socket before overwrite.
- `packages/server/src/event-wiring.ts` — the fresh consumer: persists reason + `Date.now()`, broadcasts
  `session_updated`, and logs LOUD on `unknown` (recorded, never blank).
- `packages/server/src/session-api.ts` — the bridgeless-502 prompt surface now says WHY:
  `"no bridge connection for session (last disconnect: <reason>)"`.

### Test (unit) — 20/20 green
- `packages/shared/src/__tests__/bridge-disconnect-classifier.test.ts` — each class → its reason; full
  precedence table; a brute-force sweep asserting EVERY signal combination yields a non-empty valid reason
  (fail-loud contract).
- `packages/server/src/__tests__/bridge-disconnect-reason.test.ts` — consumer persist+broadcast; `unknown`
  recorded-not-blank + logged; no-op when row already gone; the bridgeless-502 "says WHY" surface.

### Falsifiable harness acceptance (live on :8002 via a protocol-speaking WS probe)
A tiny WS client registers a session on the test gateway, then closes with a chosen code to induce each class.

| class | how induced | row `bridgeDisconnectReason` | gateway log |
|---|---|---|---|
| **clean-shutdown** | WS close 1000 | `'clean-shutdown'` + timestamp | `reason=clean-shutdown (code=1000 misses=0 crossWire=false)` |
| **unknown** | WS close 4999 (non-clean, no misses, no pid) | `'unknown'` (non-blank) | `reason=unknown …` + `[event-wiring] … UNKNOWN … recorded (never blank) but undeterminable; investigate` |
| **cross-wire** | probe A holds sid; probe B registers SAME sid (displaces A); A then closes with **1000** | final row `'cross-wire'` | A: `reason=cross-wire (code=1000 … crossWire=true)`; B: `reason=clean-shutdown` |

The cross-wire case is the strong falsifiable one: A closed with a **clean** 1000 code, yet classified
`cross-wire` — proving precedence (displacement beats the clean code), not just a code lookup. `heartbeat-
timeout` (180 s ping cycle) + `process-gone` (real pid death mid-session) are slow/racy to drive live but are
deterministically covered by the classifier unit sweep.

### Regression after W1b: **193/193** across 13 suites (adds classifier + consumer + gateway neighbors). Zero regressions.
No source consumer relied on the old `onDisconnect` arity (only a stale `dist/*.d.ts` build artifact, unused by jiti/vitest).
