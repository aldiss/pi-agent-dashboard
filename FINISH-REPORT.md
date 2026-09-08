# `/new codex` — finished and verified

Verified September 7, 2026 UTC (September 8 in Europe/Copenhagen).
Branch: `agent-codex-launch`. Starting commit: `7ab4d8aa4eb3e2af2ae4e812d831fb515b0b6265`.
Changes remain uncommitted. No push, deployment, production restart, production configuration edit, or LaunchAgent edit.

## Result

**All five requested checks pass after the final fixes.** Positive TEST dashboard and working Codex session remain running:

| Item | Observed value |
| --- | --- |
| Dashboard HTTP / bridge gateway | `127.0.0.1:8747` / `127.0.0.1:8748` |
| Dashboard server PID | `35350` |
| Source native pi PID | `38409` |
| Source pi session after native bare `/new` | `01a07e4a-a71c-72eb-8f4e-3087a6b27cc0` |
| Managed Codex session | `codex-bbe4bb06-b9a3-41ee-830a-fdaae1a93ca9` |
| Native Codex thread | `01a07e4a-d94c-7fa0-99a7-17907504de70` |
| Codex launcher / native Rust PID | `56187` / **`56201`** |
| Requested model, observed on HTTP wire | **`gpt-6-astra`** |
| Actual dashboard assistant response | **`FINISH_VERIFIED_ASTRA_0908`** |

The command now starts the managed session directly. The previous “What should the new Codex session work on?” question was a model-generated tool call, not an extension command dialog. Submit the task in the new dashboard session.

## Measured original break

Started an actual pi TUI in a pseudo-terminal against an isolated dashboard. Loaded this worktree's bridge and the installed `pi-codex` extension. Typed `/new codex`, then answered the resulting input dialog. No synthetic `spawn_new_session` frame substituted for typing.

Reproduction evidence directory:

```text
/var/folders/sh/rtc7_3wd27q_jffxy54dt44m0000gn/T/finish-codex-KeVoPh
```

`bridge-wire.jsonl` records:

| Line | UTC timestamp | Actual frame content |
| --- | --- | --- |
| 170 | `23:39:59.810` | `event_forward` → `input`, text `/new codex`, source `interactive` |
| 275 | `23:40:05.369` | Assistant `message_end` containing tool call `ask_user`, title `What should the new Codex session work on?` |
| 283 | `23:40:14.306` | `ask_user` tool result: `User responded: "Reply exactly REPRO_NATIVE_CODEX_0908. Do not edit files."` |

For source session `01a07e3e-06b5-7ca3-8d7d-27d956d59478`, **zero `spawn_new_session` frames**, including after the answer. The model subsequently answered the trivial test task itself. This reproduction does not claim to have observed `codex_dispatch`; it conclusively shows why model-selected tools could run instead of dashboard spawning.

At baseline `bridge.ts:1155`, native `input` was only forwarded as telemetry. Its handler returned without `action:"handled"`. The other native input listener only tracked queueing. The `/new` parser was reached through server-originated `send_prompt`, not native pi input. Earlier mocked `transport.receive({type:"send_prompt", ...})` tests exercised the wrong ingress for this failure.

**Decision between the proposed causes:** input already reached the model before the question appeared. There was no spawn request for the server to drop.

## Fixes

All runtime code changes stay in `packages/extension/src/bridge.ts`:

1. **Native command ingress, line 944.** Parse native pi input before forwarding. Route `/new`, `/new pi`, `/new codex`, and invalid-runtime forms through the existing command handler. Return `action:"handled"`; do not invoke the model. Preserve ordinary input and other slash-command handling. Notify on invalid runtimes or exceptions; consume failed commands too.
2. **Replacement ownership, line 1846.** Release the stopped bridge's `pi` owner after `session_shutdown` disconnect. The existing line-128 guard otherwise rejects the replacement ExtensionAPI as if it were a competing subagent. Keep generation monotonic; stale handlers cannot release the replacement or spawn through it. Live-parent reentry remains denied.
3. **Replacement context ordering, line 1258.** Cache the new `ctx` and `hasUI` before `handleSessionChange`. Live testing exposed `getCurrentModelString` reading the retired context's `model` getter, throwing “This extension ctx is stale after session replacement or reload” and preventing registration.

The last two defects were found by testing literal native bare `/new`, not inferred from source. Both received failing regression tests before fixes. The final live run starts with bare `/new`, observes its registered pi replacement, and then types `/new codex` in that replacement.

### Gateway ownership guard

`packages/server/src/pi-gateway.ts:530`–536 remains unchanged. It checks whether the **claimed/current existing session ID** belongs to a server-owned Codex session; it does not reject a requested `runtime:"codex"` by itself. Final captured spawn frame claims the ordinary pi sender ID and requests a new runtime. The existing guard accepts that frame, then `event-wiring.ts:1002` authorizes it and routes it to `runtimeManager.launch`.

No authorization widening, runtime claim spoofing, model-catalog validation, provider URL change, or `codex exec` fallback added.

## Final live evidence

Use these directories for the referenced files:

```sh
PASS=/var/folders/sh/rtc7_3wd27q_jffxy54dt44m0000gn/T/finish-codex-YhmFKH
FAIL=/var/folders/sh/rtc7_3wd27q_jffxy54dt44m0000gn/T/finish-codex-9R4qhr
```

The recorder `/tmp/finish-codex-lab.mjs` starts real servers from this worktree, real pi TUIs, transparent bridge WebSocket relays, an authenticated dashboard browser WebSocket, and transparent HTTP recorders forwarding to `127.0.0.1:4143`. It does not implement mock model responses or mock runtime adapters. It preserves the actual bridge-token WebSocket subprotocol. Authorization headers and token values are not recorded.

Positive ports: HTTP `8747`, gateway `8748`, HTTP recorder `8749`, bridge recorder `8750`.
Negative ports: HTTP `8751`, gateway `8752`, HTTP recorder `8753`, bridge recorder `8754`.
Both use separate throwaway `HOME`, `PI_CODING_AGENT_DIR`, dashboard configuration, session storage, and Codex home. Inherited tmux identity is removed. Production `8000`/`9999` are not used.

### 1. Real app-server starts from native typing — PASS

`$PASS/bridge-wire.jsonl:38`, `23:53:49.191Z`:

```json
{"type":"spawn_new_session","sessionId":"01a07e4a-a71c-72eb-8f4e-3087a6b27cc0","cwd":"/private/var/folders/sh/rtc7_3wd27q_jffxy54dt44m0000gn/T/finish-codex-YhmFKH/workspace","runtime":"codex"}
```

`$PASS/server.log:23`:

```text
[dashboard] spawn authorized by test-operator via local-bridge-delegation (bridge-ws)
```

`$PASS/bridge-wire.jsonl:40`: successful `spawn_result` at `23:53:49.690Z`.
`$PASS/process-evidence.txt` contains actual `ps` output, PID / PPID / argv:

```text
56187 35350 node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js app-server
56201 56187 /opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex app-server
```

Source pi emits **zero model `agent_start` or tool-execution events** during the final launch sequence, despite `pi-codex` tools being installed in the isolated pi configuration.

### 2. gpt-6-astra over `/v1/responses` — PASS

`$PASS/http-wire.jsonl:1`, `23:54:02.344Z`: real HTTP **POST `/v1/responses`**, JSON **`model:"gpt-6-astra"`**, carrying the test task. Recorder forwards unchanged to `127.0.0.1:4143/v1/responses`.

`$PASS/http-wire.jsonl:2`, `23:54:04.691Z`: upstream **HTTP 200** with actual streamed response containing `FINISH_VERIFIED_ASTRA_0908`. No `/v1/models` lookup validates or rejects the model.

### 3. Prompt and answer through the dashboard session — PASS

An authenticated operator browser WebSocket subscribes to the managed Codex session and sends:

```text
Reply exactly FINISH_VERIFIED_ASTRA_0908. Do not use tools or edit files.
```

`$PASS/browser-wire.jsonl:57`, `23:54:04.684Z`: that same session emits assistant `message_end` with text `FINISH_VERIFIED_ASTRA_0908`.
Line 60 emits successful `agent_end` at `23:54:04.710Z`.
This is dashboard browser-protocol evidence, not a claim of visual browser testing. Session discovery uses `session_added`, not the incomplete runtime fields in `GET /api/sessions`.

Final liveness recheck sends a second real prompt to the same running session: `What is 137 + 286? Reply only with the number; do not use tools.` Line 73 records answer **`423`** at `23:59:40.192Z`. `$PASS/final-verification.json` records assertion-backed confirmation of all five checks and the still-running native PID.

### 4. Missing environment variable must-fail control — PASS

Second real server and real pi start with `OPENAI_API_KEY` removed. Native `/new codex` starts a native thread; its first requested model turn fails without contacting the HTTP recorder.

Session: `codex-f0a466a6-467c-4755-b98b-49c03c09dfcf`.
`$FAIL/no-env-result.json` and `$FAIL/browser-wire.jsonl:25` record:

```json
{"eventType":"agent_end","data":{"error":"Missing environment variable: `OPENAI_API_KEY`.","messages":[{"role":"assistant","stopReason":"error","errorMessage":"Missing environment variable: `OPENAI_API_KEY`."}]}}
```

**42 ms** from `agent_start` to error; **46 ms** from harness submission to browser-observed error. **Zero HTTP requests.** Error is delivered to the subscribed dashboard client. Earlier independent control measured 37 ms. The final 42-ms run uses all final code fixes.

Negative server and its owned processes have been stopped. Positive test session remains available.

### 5. Pi default and delegation boundaries — PASS

- **Literal native bare `/new`:** source pi PID `38409` creates a new pi session and re-registers it at `23:53:36.996Z`. New ID: `01a07e4a-a71c-72eb-8f4e-3087a6b27cc0`. It stays pi; native bare `/new` retains pi's in-process replacement semantics.
- **Dashboard bare `/new`:** real dashboard `send_prompt` traverses the real pi bridge. `$PASS/bridge-wire.jsonl:44` contains runtime-less `spawn_new_session`; line 46 confirms **`Pi session spawned headless (pid 73748)`**. New pi session `01a07e4b-0c1b-703f-8ec5-bd604746f82d` registers. Actual argv: `sh -c tail -f /dev/null | /opt/homebrew/bin/pi --mode rpc`.
- **Delegated controls:** presenting the same isolated bridge credential without a human principal to real REST `resume`, `abort`, `shutdown`, `model`, and `flow-control` routes returns **HTTP 401**, each with `reason:"no-principal"`. Captured in `$PASS/delegation-controls.json`. Delegation grants spawn, not session-control authority. Canonical-action unit sweep also confirms only `spawn` can derive a delegated operator.

## Regression and typecheck

- Native-input red run: **6 failures / 7 passes** before ingress fix. `/tmp/finish-codex-red.log`.
- Ownership red run: **1 failure / 15 passes** before owner release. `/tmp/finish-codex-owner-red.log`.
- Context-order red run: **1 failure / 16 passes** before rebinding fix. `/tmp/finish-codex-rebind-red.log`.
- Final focused bridge file: **17 passed**. `/tmp/finish-codex-rebind-green.log`.
- Final broader regression: **973 passed, 1 skipped; 68 files passed, 1 skipped**. `/tmp/finish-codex-final-regression.log`. The skipped test is opt-in native runtime live coverage; the real native TUI/HTTP/dashboard acceptance runs above execute separately.
- Coverage includes all extension tests, shared command parsing, bridge Codex executor selection, assembled REST/browser/bridge spawn boundaries, gateway Codex-ID collision isolation, delegated spawn-only authority, spawn authorization, and Codex runtime tests.
- `npm run lint` is **not green**: 23 existing TypeScript diagnostics. Compiler runs against baseline `HEAD` versions and final modified files produce **identical diagnostic arrays**, with no new errors. `/tmp/finish-codex-typecheck-baseline.json` and `/tmp/finish-codex-typecheck-patched.json`; comparison script `/tmp/finish-codex-typecheck.cjs`. Unrelated existing errors left untouched.
- `git diff --check` passes.

## Reproduction and retained lab

Recorder uses only allowed test base ports `8747` and `8751`:

```sh
node /tmp/finish-codex-lab.mjs
FINISH_PORT=8751 node /tmp/finish-codex-lab.mjs --no-env
```

Run with a terminal attached. JSON input `{"type":"type","text":"/new codex\r"}` types into the actual pi pseudo-terminal. `{"type":"browser","frame":{...}}` sends dashboard browser frames. `{"type":"stop"}` cleans up that lab. Do not launch a second copy over the retained positive lab.

The retained lab has `requireBrowserAuth:true`; it does not expose an unauthenticated session-control bypass. Browser tests sign the isolated `test-operator` identity using the isolated configuration's test signing secret. For manual inspection, use a separate browser profile, generate a local test JWT with `jsonwebtoken` from that configuration, and set browser cookie `pi_dash_token` for the test host. Keep test cookies separate from the production browser profile; cookies are not port-scoped. No production identity or credential is required.

Retained recorder PID: `35341`; server PID: `35350`; native pi PID: `38409`. To remove the retained lab, first verify these PIDs' argv still match the test paths, then terminate the test server, native pi, and recorder. Server shutdown owns cleanup of Codex and dashboard-spawned pi children. No broad `pkill` or production-port shutdown is appropriate.
