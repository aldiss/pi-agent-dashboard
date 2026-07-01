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
