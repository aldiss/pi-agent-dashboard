# BUILD REPORT — agent-launched Codex sessions

**Worktree:** `/Users/vdrobkov/Misc/Documents/Copilot/_wt-agent-codex-launch`
**Branch:** `agent-codex-launch`, cut from `origin/main` `956511f5`
**State:** uncommitted working tree. No commit, no push, no restart, no config change.

## Outcome

An agent inside a pi session can now type `/new codex` and get a Codex session in
the dashboard, through the same authorization gate and the same executor the
browser path already used. A bare `/new` is unchanged, byte-for-byte on the wire.

---

## The gap — five layers, each verified own-hand

Every layer confirmed by reading the file at the cited line before touching it.
The brief's trace was accurate; one correction and one addition below.

| # | Layer | Found | Fixed |
|---|---|---|---|
| 1 | `/new` grammar | `parseSendPrompt` returned bare `{type:"new"}`; no argument in the grammar | `{type:"new"; runtime}` + `{type:"new-invalid"; requested}` |
| 2 | `spawnNew` callback | `spawnNew?: () => void` — zero parameters (`command-handler.ts:83`) | `spawnNew?: (runtime?: SessionRuntime) => void` |
| 3 | bridge send | `spawn_new_session {type, sessionId, cwd}` (`bridge.ts:846`) | forwards `runtime` when non-pi |
| 4 | protocol | `SpawnNewSessionMessage` had no runtime field (`protocol.ts:300`) | optional `runtime?: SessionRuntime` |
| 5 | **executor divergence** | `event-wiring.ts:998` passed `runtime:"pi"` as a hardcoded literal, then called `spawnPiSession` — a pi-only executor | passes the requested runtime; routes codex to `runtimeManager.launch()` |

**Correction to the brief.** Layer 1 does not live in `command-handler.ts`. The
grammar moved to `packages/shared/src/prompt-command.ts` (`parseSendPrompt`) so
the server authorizes against the same parser the bridge executes;
`command-handler.ts` re-exports it. Editing the grammar in the extension would
have desynchronized the server's operator-only classification of `/new`. Fixed
in shared, which keeps that property by construction.

**What the browser path calls for codex** (the brief asked me to find it):
`handleSpawnSession` → `ctx.runtimeManager.launch({cwd, requestId, attachProposal})`
(`session-action-handler.ts:699`). The bridge path now calls the same method.

**Addition the brief did not list — the wiring gap.** `EventWiringDeps` had no
access to `runtimeManager` at all, so there was nothing for the bridge path to
route *to*. `runtimeManager` is constructed at `server.ts:994`, *after*
`wireEvents` at `:976`, because it consumes the ingest callback `wireEvents`
returns. I used the same deferral the browser gateway already uses for the
identical reason — a lazy `getRuntimeManager: () => runtimeManager` accessor
(`server.ts:792` passes `() => runtimeManager` to `createBrowserGateway`). No new
pattern introduced.

Two further call sites keyed on `parsed.type === "new"` and pre-authorized the
spawn as pi (`session-api.ts:348`, `session-action-handler.ts:314`). Both now
pre-authorize against the runtime actually requested, so a disabled runtime is
refused at those seams too instead of being authorized as pi and refused later.

---

## The pi-gateway invariant — argued, not assumed

`pi-gateway.ts:531` carries:

```ts
// Runtime ownership comes from server state, never bridge fields.
if ((claimedId && sessionManager.get(claimedId)?.runtime === "codex")
  || (currentSessionId && sessionManager.get(currentSessionId)?.runtime === "codex")) return;
```

**Conclusion: no conflict. The change is consistent with the invariant, and the
invariant keeps binding unweakened.** The argument, in four steps:

1. **What the guard actually reads.** Both operands are
   `sessionManager.get(id)?.runtime` — server state, keyed by an id of a session
   that *already exists*. The guard never reads a field off `msg`. It is a
   **drop rule for messages aimed at an existing codex-owned session**: a pi
   bridge must not drive a row the Codex adapter owns.

2. **What a spawn request is.** `spawn_new_session` names no existing session.
   Its `sessionId` is the *caller's own pi session* (the agent typing `/new`),
   not a target. The session being created has no id yet — the server mints
   `codex-${randomUUID()}` at `runtime-manager.ts:206`. There is no row for the
   bridge field to claim. The guard's subject and the field's subject are
   disjoint.

3. **The field is a request, not a grant.** The bridge-supplied `runtime` is
   consumed *only* by `runSpawnGate` → `authorizeSpawn`, which tests it against
   `policy.enabledRuntimes` and denies `runtime-not-enabled` otherwise. It never
   reaches `sessionManager`. The created session's actual runtime is a
   **server-side literal**: `runtime: "codex"` is written by
   `runtime-manager.ts:206` and again at `:115`, independent of anything the
   bridge sent. A bridge cannot make a session codex-owned by asserting it — it
   can only ask, and be refused.

4. **The precedent is in the same message.** `cwd` is already a bridge-supplied
   field on `spawn_new_session`, and it is handled exactly this way: the server
   realpath-resolves it (`resolveSpawnCwd`) and containment-checks it against
   `permittedRoots`, then uses `decision.cwd` — the server-validated value —
   never `msg.cwd`. `runtime` now has the same status: bridge-*requested*,
   server-*decided*. The codex branch launches on `decision.cwd`, not `msg.cwd`.

The invariant would be violated by letting a bridge field determine the runtime
of a session the server already owns. This change does the opposite: it adds a
request that must survive a server-side allowlist before a server-side literal
assigns the runtime. `pi-gateway.ts` is untouched.

Documentation note: the invariant is not written down as a rule anywhere in
`docs/` — only its effects are (`file-index-server.md:71`, `architecture.md:318`).
`runSpawnGate` has no doc coverage either. Worth a `docs/architecture.md` entry
under the existing "Spawn Authorization Boundary" section; not done here, as the
brief scoped this to the build and docs writes are a delegated-subagent protocol.

---

## Authorization — unchanged, unweakened

- `spawn-authz.ts` — **untouched** (`git diff --name-only` confirms). No rule
  ties runtime to principal; it did not need one.
- `pi-gateway.ts` — **untouched**.
- The bridge path is still gated: `event-wiring.ts` still calls `runSpawnGate`
  with `channel:"bridge-ws"`, now with the requested runtime rather than a
  literal. Every pre-existing condition — bridge token, loopback, no-forwarding,
  delegation, operator membership, cwd containment — still applies to codex, and
  is asserted (`bridge-codex-spawn.test.ts`).
- Delegation still grants **spawn only**. `deriveDelegatedBridgeOperator` returns
  `refused/not-spawn` for every other action. Asserted mechanically over the
  entire canonical action set, not a hand-written list, so it cannot drift.
- Codex is refused, never silently downgraded to pi, when the runtime manager is
  unavailable.

---

## Test results — measured, not claimed

Both runs are full `npm test` on this machine. Dependencies were absent in the
fresh worktree; `npm install` ran before both, so the two are comparable.

| | Test files | Tests |
|---|---|---|
| **Baseline** — `origin/main` `956511f5`, clean tree | 3 failed, 695 passed, 3 skipped (701) | **8 failed**, 7473 passed, 18 skipped (7499) |
| **With this change** | 3 failed, 700 passed, 3 skipped (706) | **8 failed**, 7499 passed, 18 skipped (7525) |

**The suite has 8 pre-existing failures at `origin/main`.** The failing-test sets
are byte-identical between the two runs (diffed; only per-test millisecond
timings differ). Same 3 files, same 8 assertions:

- `packages/shared/src/__tests__/no-direct-process-kill.test.ts` (1) — flags
  `packages/server/src/driver-liveness.ts:65`, a file this change never touches.
- `packages/client/.../ChatView.test.tsx` (5) and
  `ChatView.streaming-text-flush.test.tsx` (2) — client rendering, untouched here.

**Net: +26 passing tests, 0 new failures, 0 pre-existing failures fixed.**

Typecheck: `npx tsc --noEmit` reports **22 errors before and 22 after** — all
pre-existing and in files this change does not touch. Zero new type errors.
(The two `server.ts` errors are a pre-existing duplicate `resurrectionSweepMs`
at lines 141/171, verified present at `origin/main` by stashing.)

### Must-fail control — observed failing, twice

Not asserted; watched.

1. **Grammar, before implementing.** `prompt-command-new-runtime.test.ts` run
   against the unmodified parser: **5 failed / 2 passed**. `/new codex` parsed as
   `{type:"slash", text:"/new codex"}` — i.e. today it leaks to the model as a
   generic slash command. The 2 that passed are the bare-`/new` default and the
   `/newsletter` non-collision — correct, they pin behavior that must *not*
   change.

2. **Layer 5 routing, after implementing.** I reverted only the
   `event-wiring.ts` routing (restored `runtime:"pi"`, deleted the codex branch),
   left grammar and protocol in place, and re-ran: **3 failed / 4 passed** —
   exactly the three codex-routing assertions, while the pi-default assertions
   stayed green. That is the control working in both directions: it detects the
   bug, and it does not fire on the default path. Restored, 7/7.

   Of note: with the hardcoded literal, the `runtime-not-enabled` test fails by
   **spawning a pi session** on a codex request. Pre-fix, the divergence was not
   just "codex doesn't work" — a codex request with codex disabled would have
   silently produced a pi session.

### Acceptance criteria

| # | Criterion | Evidence |
|---|---|---|
| 1 | config-disabled → codex denied `runtime-not-enabled` | `bridge-codex-spawn.test.ts` — asserts the deny reason and that neither executor runs |
| 2 | config-enabled + delegated loopback bridge → codex ACCEPTED | `bridge-codex-spawn.test.ts` (server half, real `createSpawnGate`) + `bridge-new-runtime.test.ts` (wire half) |
| 3 | delegated resume/abort/shutdown/model/flow-control remain denied | `delegated-bridge-spawn-only.test.ts` — the five named, plus a sweep over the whole action set proving `["spawn"]` is the complete grant |
| 4 | bare `/new` still spawns pi | all three seams: parser, `spawnNew("pi")`, and a wire frame with no `runtime` key |
| 5 | unknown/invalid runtime rejected visibly | bridge emits `command_feedback{status:"error"}`, sends no spawn frame, does not leak to the model; server-side, a forged wire value never reaches the codex executor |
| 6 | tests for each, incl. a seen-failing control | 26 tests across 5 files; control observed failing twice, above |

Criterion 1 is tested at the gate with `enabledRuntimes:["pi"]` rather than by
mutating `~/.pi/dashboard/config.json`, which the brief forbids. That is the same
value `server.ts:697` derives from `codexConfig.enabled`, so the tested policy is
the shipped one.

---

## Files changed

Production (9 files, +116/−19):

```
packages/shared/src/prompt-command.ts                        grammar: /new [runtime]
packages/shared/src/protocol.ts                              optional runtime on spawn_new_session
packages/extension/src/command-handler.ts                    spawnNew(runtime); refuse new-invalid
packages/extension/src/bridge.ts                             forward runtime when non-pi
packages/server/src/event-wiring.ts                          gate on requested runtime; route codex
packages/server/src/server.ts                                lazy getRuntimeManager into wireEvents
packages/server/src/session-api.ts                           REST /new pre-auth on real runtime
packages/server/src/browser-handlers/session-action-handler.ts  WS /new pre-auth on real runtime
packages/extension/src/__tests__/command-handler.test.ts     updated for the new parse shape
```

New tests (5 files, 26 tests):

```
packages/shared/src/__tests__/prompt-command-new-runtime.test.ts
packages/extension/src/__tests__/command-handler-new-runtime.test.ts
packages/extension/src/__tests__/bridge-new-runtime.test.ts
packages/server/src/__tests__/bridge-codex-spawn.test.ts
packages/server/src/__tests__/delegated-bridge-spawn-only.test.ts
```

## Constraints

- No commit, push, deploy, or restart. `git log origin/main..HEAD` = 0 commits.
- `~/.pi/dashboard/config.json` and LaunchAgent plists untouched.
- No other worktree touched.
- `spawn-authz.ts` and `pi-gateway.ts` untouched.
- No TSX/HTML authored, so the frontend skill gate did not apply — the whole path
  is agent → bridge → server. `command-handler.test.ts` is `.ts`.

## Not done, deliberately

- **Docs.** Per the repo's documentation protocol, `docs/` writes are delegated
  and were out of the brief's scope. Two gaps are worth filing: the pi-gateway
  ownership invariant is not stated as a rule anywhere, and `runSpawnGate` has no
  coverage. New rows would be needed for the 5 test files and updates for
  `event-wiring.ts` / `prompt-command.ts` / `protocol.ts`.
- **Runtime verification against a live Codex binary.** The build is unrun
  end-to-end — no restart was permitted, so `launch()` is asserted as called with
  the validated cwd, not observed starting a real `codex app-server`. The first
  live `/new codex` is still unproven and should be the next gate.
- **Client UI.** `/new codex` is an agent/bridge path; the browser already had
  its own codex spawn button. Nothing in `packages/client` needed changing.

---

# LIVE VERIFICATION — operator-authorized, run 2026-09-07

The gate this report itself named. Everything below is observed, not inferred.

**Isolation.** Dashboard server booted from THIS worktree on ports **8747/8748**
under a throwaway `HOME`. Production (`:8000` browser / `:9999` gateway, PID
16125) was never touched — verified same PID and uptime 77329 s (no restart)
after every arm. Real `~/.pi/agent/settings.json` still dated Sep 6 10:10 and
contains no reference to this worktree; real `~/.pi/dashboard/config.json`
untouched. `CODEX_HOME` derives from `os.homedir()`, so the isolated `HOME`
sandboxed codex's config, sessions, and thread files completely.

## 1. Did a real `codex app-server` process start? — YES

Driven by a REAL bridge-ws frame over loopback, token-authenticated:
`spawn_new_session { sessionId, cwd, runtime: "codex" }` — the exact frame
`/new codex` emits. Server log:

```
[gateway] session registered: live-verify-with-env cwd=…/workspace
[dashboard] spawn authorized by aldiss via local-bridge-delegation (bridge-ws)
```

Two real OS processes, launcher → native binary:

```
PID 12214  ppid 92746  node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js app-server
PID 12250  ppid 12214  /opt/homebrew/lib/node_modules/@openai/codex/node_modules/
                       @openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex app-server
```

`spawn_result { success: true, message: "Codex session started" }`. Session row:
`runtime:"codex"`, `status:"idle"`, `model:"gpt-6-astra"`, real
`codexThreadId: 01a07d22-…`, real rollout JSONL on disk. codex-cli 0.144.1.

**The delegated-spawn path works end-to-end against a real binary.**

## 2. Did it reach `gpt-6-astra` through :4143? — YES

Codex was pointed at a recording proxy that logged each request and forwarded
verbatim to the real `:4143`. Through the REAL runtime manager
(`manager.launch()` → `manager.send()` — the object the bridge path now calls):

```
WIRE  POST /v1/responses  model=gpt-6-astra  auth=true  →  HTTP 200
```

Model reply, streamed token-by-token and captured from the mapped events:

```
message_update  {"message":{"role":"assistant","content":[{"type":"text","text":"ROUND"}]}}
message_update  … "ROUNDTR" … "ROUNDTRIP" … "ROUNDTRIP-" … "ROUNDTRIP-OK"
message_end     {"message":{"role":"assistant","content":[{"type":"text","text":"ROUNDTRIP-OK"}]}}
stats_update    {"tokensIn":13814,"tokensOut":9,"contextUsage":{"contextWindow":258400}}
```

The prompt was "Reply with exactly: ROUNDTRIP-OK". The model returned exactly
that. Token accounting landed on the session row. `turn/completed` in 4080 ms.

That is a real model round-trip, not an inference from a started process.

## 3. Failure legibility — GOOD, both at codex and at the dashboard

No silent no-op found in the product. (One appeared mid-verification and was
**my harness's bug**: it waited on `message_end` + `status:idle`, which fire
~2 s in, BEFORE the ~4 s round-trip, and it read assistant text from
`data.text` when the real shape is `data.message.content[].text`. Both fixed;
the corrected harness shows the full exchange. Recording it because a
premature "silent no-op" conclusion would have been a false alarm on a working
product.)

## 4. THE CONTROL — env var removed. Fails differently and visibly.

Same config, same binary, `OPENAI_API_KEY` absent:

| | sentinel present | sentinel REMOVED |
|---|---|---|
| HTTP to :4143 | `POST /v1/responses → 200` | **none — zero requests** |
| turn status | `completed` | **`failed`** |
| thread status | `idle` | **`systemError`** |
| duration | 4080 ms | **35 ms** |
| codex error | none | ``Missing environment variable: `OPENAI_API_KEY`.`` |
| `willRetry` | — | **`false`** (no retry storm) |

And it survives the adapter's mapping — the dashboard sees it:

```json
agent_end {
  "error": "Missing environment variable: `OPENAI_API_KEY`.",
  "messages": [{"role":"assistant","stopReason":"error",
                "errorMessage":"Missing environment variable: `OPENAI_API_KEY`."}]
}
```

**The must-fail arm passes.** A missing credential fails fast, names the exact
variable, does not retry, and reaches the UI as a terminal turn error. Enabling
the flag does not create a silent-failure mode.

## 5. Is baseUrl `/v1` correct against a `/responses` backend? — YES, verified

This was flagged as set-but-unverified. It is correct, and the reason is
mechanical rather than lucky:

- `codex-config.ts` hardcodes `wire_api = "responses"`, so codex POSTs to
  `{base_url}/responses`.
- With `base_url = "http://127.0.0.1:4143/v1"` that is
  **`/v1/responses`** — confirmed on the wire (§2), not assumed.
- Direct probe of the backend:
  - `POST /v1/responses` with `gpt-6-astra` → **200**, real text, real usage.
  - `POST /v1/chat/completions` with `gpt-6-astra` → **refused**:
    `model "gpt-6-astra" is not accessible via the /chat/completions endpoint`
    (`unsupported_api_for_model`).

So `/v1` is not merely acceptable — it is **required**. Dropping it would yield
`/responses`, and the `chat/completions` shape is explicitly unsupported for
this model. **Leave the value as configured.**

### Two findings worth the operator's attention

1. **`gpt-6-astra` is served but NOT advertised.** It is absent from
   `GET /v1/models` (43 models listed, no `astra`), yet `POST /v1/responses`
   serves it and bills it. Anything that validates a model id against the
   catalogue would wrongly reject it. Not a blocker — codex does not check.

2. **Codex warns on every turn:**
   `Model metadata for `gpt-6-astra` not found. Defaulting to fallback
   metadata; this can degrade performance and cause issues.`
   Benign here (context window resolved to 258400 and the turn succeeded), but
   it is codex's own caution, it recurs per turn, and it traces to the same
   catalogue gap as finding 1. `runtimes.codex.modelCatalogJson` exists as a
   config field and would likely silence it — untested, and out of scope
   without authorization to change config.

## Verdict

`/new codex` from an agent starts a real `codex app-server`, reaches
`gpt-6-astra` over `/v1/responses`, streams a correct reply, and books tokens.
Credential failure is loud, fast, non-retrying, and visible in the UI. The
`/v1` baseUrl is verified required. No production state was read or written.

Harness scripts were deleted after the run; the worktree diff is unchanged from
the build section above.
