# Delegated Send + Codex Queue Report

Date: September 8, 2026.

## Result and Isolation

Both gaps implemented and proven against isolated dashboards with real pi and native Codex processes. Final live acceptance: **PASS**. Both deliberately broken live controls: **FAIL at the intended assertion**. Safeguards restored; corrected live acceptance and focused tests pass.

Worktree: `/Users/vdrobkov/Misc/Documents/Copilot/_wt-send-queue`.
Branch: `agent-send-queue`, cut from `origin/main` at `b151dad9cf6aada21f3989ada51496f85cf4ed11`.
Changes remain uncommitted. No push, deployment, production restart, or cutover.

Original `_wt-codex-runtime` worktree remains untouched, with its 60 dirty paths. No changes to protected deploy scripts, platform tests, `ChatView*.test.tsx`, `driver-liveness.ts`, or `platform/process.ts`. No edits to production dashboard config or LaunchAgent plists.

## Authorization

- `packages/server/src/spawn-authz.ts:76`: delegation allow-list becomes exactly `spawn` plus `send_prompt`. All other verbs and unknown future actions remain refused.
- Existing token verification, strict `isSpawnLoopback`, forwarding rejection, operator selector/membership checks, explicit disable, and 60-second principal lifetime remain intact.
- `packages/server/src/rest-session-gate.ts:73`: private-token ingress through existing `POST /api/session/:id/prompt`, using `x-pi-bridge-token`. Header must match startup-loaded private bridge token. No human JWT minted.
- REST bridge-token authority permits only plain `send_prompt`. Slash/shell commands and every lifecycle action remain denied, including with browser-auth flag off. Missing header retains existing REST authentication behavior; anonymous single-operator behavior was not redesigned.
- Successful send uses a `service` actor, not a human actor carrying the selected operator's identity. Principal exists only for delegation selection/audit.
- `packages/server/src/session-api.ts:329`: author fixed to `{ sub: "local-bridge", display: "pi bridge (delegated)", isOperator: false }`. Body-supplied author/principal cannot override it.
- Existing shared speaker sanitizer and fresh nonce envelope apply at pi/Codex model-facing boundaries. Live native wire inspection proves forged operator `<speaker>` markup neutralized and forged body author ignored.
- Ended/unattached Codex still requires separate `resume` authorization. Delegated send cannot resurrect or implicitly resume it.

Agent request contract:

```text
POST /api/session/<active-session-id>/prompt
x-pi-bridge-token: <read locally from ~/.pi/dashboard/bridge-token>
Content-Type: application/json

{"text":"message","queueNonce":"unique-message-id"}
```

Use loopback only. Never include token in model prompts, logs, or remote requests.

Actual audit records from final test dashboard:

```json
{"event":"send_prompt_authorized","sessionId":"codex-e0c21f7c-21fe-4518-910f-9bc022c8e25c","actor":{"kind":"delegated","sub":"local-bridge","provider":"local-bridge-delegation","delegatedBy":"send-test-operator"},"queueNonce":"agent-loop"}
{"event":"send_prompt_authorized","sessionId":"codex-e0c21f7c-21fe-4518-910f-9bc022c8e25c","actor":{"kind":"human","sub":"send-test-operator","provider":"github"},"queueNonce":"human-stop-test"}
```

Delegated record names authorizing operator only under `delegatedBy`, never as sender.

## Queue and Failure Policy

`packages/server/src/runtime/codex-adapter.ts` owns a per-session FIFO on the server. Existing runtime manager already owns exactly one adapter per attached Codex session. No extension bridge required.

- Busy sends acknowledge enqueue instead of throwing. FIFO retains raw text, images, author, and `queueNonce`; absent queued nonce gets UUID.
- Emits existing `message_enqueued` and `queue_state` shapes. `followUp` ordered; `pendingMessageCount` matches pending FIFO length; `steeringCount` zero.
- Native turn completion schedules next dispatch. Dequeued `message_start` carries original nonce and commits correct user message before queue snapshot removes it.
- Adapter protects mapper from concurrent starts. Mapper's internal active-turn assertion remains an invariant, not an externally reachable busy-send rejection.
- Queued native provider failure emits terminal `agent_end` error and `send_prompt_failed` with failed input's original nonce. Original text remains in committed chat history.
- Fatal transport/disposal failures cancel pending entries. Runtime manager forwards failure notifications to session subscribers, not every browser.
- **Stop clears pending queue**, then interrupts active turn. Pending messages receive nonce-correlated failure and persistent `command_feedback` containing their text; authoritative queue becomes empty. This prevents queued work automatically restarting after Stop.
- Delta correction: authoritative `send_prompt_failed` marks matching optimistic or confirmed pending cards failed. Empty `queue_state` retains these cards for Retry/Dismiss. Local timeout remains optimistic-only; already committed messages are not recreated. No parallel queue protocol or iOS protocol extension introduced.
- FIFO execution remains in memory; pending work does not automatically execute after dashboard restart. Crash-durable queue execution not added.
- `packages/client/src/components/CommandInput.tsx:171`: removes Codex-only busy disable. Desktop/mobile composers retain Stop while permitting follow-ups. Pi behavior unchanged.

## Final End-to-End Evidence

Harness: `scripts/send-queue-acceptance.ts`.
Artifacts: `/tmp/codex-runtime-browser-send-oSCI0B/`.
Run: **2026-09-08 07:18:49–07:19:26 UTC**, result **PASS**.

| Resource | Recorded value |
|---|---|
| Test HTTP / pi gateway | `49675` / `49674` |
| Isolated HOME | `/tmp/codex-runtime-browser-send-oSCI0B` |
| Dashboard PID | `45013` |
| Real pi session / PID | `01a07fe2-42bc-7bc4-947a-79742606afff` / `50519` |
| Managed Codex session / PID | `codex-e0c21f7c-21fe-4518-910f-9bc022c8e25c` / `51837` |
| Native Codex thread | `01a07fe2-47d1-7ed1-ac46-d14f16db874f` |
| Cleanup | All recorded owned PIDs exited; `survivors: []` |

Harness uses dynamic ports, isolated config/session registries, disabled production plugins, pinned bridge URL, and native executables from tool registry. It rejects dashboard ports `8000` and `9999`. Model calls use configured model endpoint; a separate isolated forwarding proxy injects one deterministic provider error without mocking runtime.

| Acceptance | Observed proof |
|---|---|
| Agent-driven spawn and answer | Ordinary real pi RPC session receives `/new codex`; dashboard creates native managed Codex. Pi model invokes actual bash tool to POST through private-token ingress. Helper reads answer through dashboard events; pi tool result receives `AGENT_DRIVEN_ANSWER`. |
| Both runtime targets | Same delegated REST path also yields real `PI_DELEGATED_ANSWER` from pi. |
| Busy FIFO | First native turn runs `sleep 5`. Second send returns HTTP 200 and emits `message_enqueued`/`queue_state` with `fifo-2`. Answers include `FIRST_FIFO_DONE`, then `SECOND_FIFO_DONE`. First terminal event index 32; second user-start index 34. No busy error reaches client. |
| Failed queued message | Follow-up first enqueued with `provider-failed-nonce`; isolated proxy returns HTTP 400 to its native model request. Native runtime emits committed user message, terminal error, and matching `send_prompt_failed`. Text retained. |
| Still-denied verbs | Live REST returns 403 for resume, abort, shutdown, resurrect, hide, unhide, flow-control, and model. Canonical action sweep additionally checks every action, including `force_kill` and protocol spellings. |
| Force kill | Bridge token alone cannot enter browser WS: HTTP 401. Actual `force_kill` message from signed non-operator browser carrying bridge token and forged principal receives `{success:false,message:"unauthorized"}`; native Codex PID stays alive. |
| Hostile transports | No token: 401. Wrong token: 403. `forwarded`, `x-forwarded-for`, `x-forwarded-host`, and `x-real-ip`: 403. Real non-loopback socket with valid token and valid human cookie: 403, exercising delegation's own boundary rather than merely outer authentication. |
| Attribution | Distinct delegated/human audit records above; delegated UI author non-operator. Native model request contains server-minted `local-bridge` speaker, not forged operator envelope. |
| Stop | Human Stop cancels queued `stop-cancelled`, sends exact nonce failure, persists `CANCELLED_QUEUE_TEXT` error feedback, and never starts that queued turn. |
| Implicit resume denied | After authorized shutdown, delegated prompt receives 403 and native PID remains dead. |

Live verification operates through real HTTP/WS and native processes, not only mocked adapter tests. Composer usability also covered by DOM integration tests. No physical iOS device exercised; compatibility claim concerns unchanged protocol shapes.

## Must-Fail Controls

Both mutations temporary, applied only in this new worktree; each test dashboard uses its own HOME and ports. Both reverted before corrected verification.

| Deliberate break | Live verifier result | Artifacts |
|---|---|---|
| Remove `!isSpawnLoopback(input.remoteAddress)` from delegation gate | Exit 1: `Non-loopback delegation returned 200` | `/tmp/codex-runtime-browser-send-IlGRFy/`; `/tmp/send-live-loopback-must-fail.log` |
| Restore busy `if (active) throw new Error("Codex turn already active")` ahead of FIFO | Exit 1: `Busy follow-up must enqueue`, `409 !== 200` | `/tmp/codex-runtime-browser-send-YVq0Bw/`; `/tmp/send-live-queue-must-fail.log` |

Both negative runs also record `survivors: []`.
Unit controls independently fail: loopback mutation causes 4 failures; queue removal causes 3 failures. Logs: `/tmp/send-loopback-must-fail.log`, `/tmp/send-queue-must-fail.log`.
Initial TDD red runs captured before implementation: `/tmp/send-queue-red.log`, `/tmp/send-auth-red.log`, `/tmp/send-client-red.log`.
Corrected live run after mutation restoration: `/tmp/codex-runtime-browser-send-9T5hm2/`, **PASS**. Final expanded run with explicit force-kill message: `/tmp/codex-runtime-browser-send-oSCI0B/`, **PASS**.

## Tests and Caveats

- Focused verification after restoration: **242 passed, 1 opt-in live unit test skipped**, 17 files passed. Separate native live harness passes. Log: `/tmp/send-restored-tests.log`.
- Coverage includes delegation adversarial matrix, REST/WS authorization closure, route coverage, bridge spawn boundary, full Codex runtime tests, composer controls, and queue round-trip integration.
- `npm run build`: **PASS**. Log: `/tmp/send-build.log`.
- `git diff --check`: **PASS**.
- Repository-wide Vitest attempt not claimed green. It encountered a WS-closure shutdown timeout and was interrupted rather than continuing broad run alongside concurrent test-gate work. That exact file passes in subsequent focused runs. Partial log: `/tmp/send-full-tests.log`; interrupted exit 130.
- Repository `npm run lint` not green: 23 TypeScript diagnostics, including existing duplicate `resurrectionSweepMs` declarations and unrelated composer/translator test types. No diagnostics reported for new delegation/queue implementation. Unrelated issues left untouched. Log: `/tmp/send-lint.log`.

Reproduce live proof with existing model credential environment:

```bash
PI_CODEX_TEST_MODEL=gpt-6-astra \
PI_CODEX_TEST_BASE_URL=http://127.0.0.1:4143/v1 \
node_modules/.bin/tsx scripts/send-queue-acceptance.ts
```

`OPENAI_API_KEY` must already be available. Harness never writes it to config or report. Artifacts stay under fresh `/tmp/codex-runtime-browser-send-*` HOME; harness shuts down its own processes.

Final artifact SHA-256:

```text
evidence.json        d5a66a86661ae04f2b7ba6491a1bf79e4a7fc41c08ec3723552325cf7dc17588
browser-frames.jsonl be945a59069f63e114ad8342699a4b7ba54337fd0ff6261b73485736ec3af8ee
pi-frames.jsonl      cac81e6435e7c66b54eccb7060b81d6bd43ae78db298195b648e87cf41f4f048
dashboard.log        42a7a006812d4d6ebdec562a2d070439ffe5c8335e1ddd17c99f07e69aace5fd
```

## Delta: Confirmed Queue-Card Recovery — September 8, 2026

Only the named client recovery gap reopened. Original completed build retained; no rebuild, commit, push, deploy, permission expansion, guest-policy change, or production-service/config/plist touch.
Branch remains `agent-send-queue`; HEAD remains `b151dad9cf6aada21f3989ada51496f85cf4ed11`.
Original tracked diffs outside delta scope compared byte-for-byte with `/tmp/send-queue-delta-baseline.patch`: preserved, including every server/auth implementation and original composer change.

### Correction and Coverage

- `packages/client/src/lib/event-reducer.ts`: `markQueueEntryFailed(state, nonce, source = "local")` preserves optimistic-only local timeout behavior. Only explicit `"server"` failure accepts confirmed pending cards. Missing/already-dispatched/already-failed entries remain no-ops.
- `packages/client/src/hooks/useMessageHandler.ts`: actual WS `send_prompt_failed` handler passes `"server"`. Existing `queue_state` preservation and Retry/Dismiss handlers need no production changes.
- `packages/client/src/components/__tests__/queue-roundtrip-integration.test.tsx`: replaces simulated WS failure helper with actual `useMessageHandler`; wires actual `useSessionActions`, timeout hook, reducer, and rendered `ChatView` Retry/Dismiss buttons. Pins original nonce/text, one failed card after empty snapshot, no automatic submission, exactly one send on explicit Retry with fresh nonce, late old-nonce inertness, and Dismiss without send.
- Covers Stop, transport/disposal/bridge failure reasons, stale local timeout after confirmation, disconnect with confirmed pending entry, missing/unmatched nonce, wrong session, and committed provider failure without queue-card resurrection or duplicate retry. Existing pi queue tests remain included.
- `packages/server/src/runtime/__tests__/codex-adapter.test.ts`: two added tests use real mapper with fake native transport to prove disposal/transport callbacks preserve explicit/generated nonce and text, precede empty queue snapshot, never dispatch pending work, and never repeat failures on second disposal. No adapter production delta.
- Documentation updates delegated under repository caveman rule: architecture and client/server/script indexes only.

### RED → GREEN → Reverted RED

Initial regression command, before correction:

```bash
HOME=$(mktemp -d /tmp/send-delta-unit-XXXXXX) node_modules/.bin/vitest run packages/client/src/components/__tests__/queue-roundtrip-integration.test.tsx > /tmp/send-delta-red.log 2>&1
```

Result: **4 failed, 12 passed**, exit 1. All four authoritative confirmed-card tests receive `[]` instead of original failed card after empty snapshot. Initial bare Vitest invocation was safely refused by HOME isolation gate before running tests; all actual test runs use temporary HOME.

First corrected focused runs:

```bash
HOME=$(mktemp -d /tmp/send-delta-unit-XXXXXX) node_modules/.bin/vitest run packages/client/src/components/__tests__/queue-roundtrip-integration.test.tsx packages/client/src/lib/__tests__/event-reducer-queue.test.ts > /tmp/send-delta-green.log 2>&1
HOME=$(mktemp -d /tmp/send-delta-unit-XXXXXX) node_modules/.bin/vitest run packages/server/src/runtime/__tests__/codex-adapter.test.ts packages/client/src/components/__tests__/queue-roundtrip-integration.test.tsx packages/client/src/lib/__tests__/event-reducer-queue.test.ts > /tmp/send-delta-cancel-tests.log 2>&1
```

Results: **53 passed**; then **77 passed, 1 opt-in real-frame replay skipped**, both exit 0.

After live capture, removed only correction's `source` parameter/guard and WS `"server"` argument with `apply_patch`, restoring original optimistic-only behavior. Left original build and new tests intact. Ran:

```bash
HOME=$(mktemp -d /tmp/send-delta-unit-XXXXXX) PI_SEND_QUEUE_FRAMES=/tmp/codex-runtime-browser-send-yXamgX/browser-frames.jsonl node_modules/.bin/vitest run packages/client/src/components/__tests__/queue-roundtrip-integration.test.tsx > /tmp/send-delta-reverted.log 2>&1
```

Result: **5 failed, 12 passed**, exit 1. Four synthetic authoritative cases fail at missing card; real-frame replay fails at missing `CANCELLED_QUEUE_TEXT` failed card after actual empty snapshot. Correction restored immediately with `apply_patch`; no original build edits reverted.

### Real Test Dashboard and Client Replay

Inspected `scripts/send-queue-acceptance.ts` and its owned IPC server before running. Fresh temporary HOME, CODEX_HOME, pi session/config/registry paths; dynamic HTTP/pi/model-proxy ports; dashboard production ports 8000/9999 rejected; native pi bridge pinned to isolated gateway; cleanup restricted to owned processes. Existing model endpoint receives only test traffic. No credential discovery required: local non-secret sentinel used.

```bash
OPENAI_API_KEY=send-queue-local-sentinel PI_CODEX_TEST_MODEL=gpt-6-astra PI_CODEX_TEST_BASE_URL=http://127.0.0.1:4143/v1 node_modules/.bin/tsx scripts/send-queue-acceptance.ts > /tmp/send-delta-live.log 2>&1
```

Result: **PASS**, exit 0. September 8, 2026, **07:58:03–07:58:58 UTC**.

| Resource | Delta-run evidence |
|---|---|
| Artifacts / isolated HOME | `/tmp/codex-runtime-browser-send-yXamgX/` |
| Test HTTP / pi gateway | `60172` / `60170` |
| Owned dashboard / pi / native Codex PIDs | `46430` / `53597` / `54907` |
| Real pi session | `01a08006-30bc-7195-89b9-0a81ee9dacd3` |
| Managed Codex session | `codex-c30dfb38-59b2-4036-9945-91e79059ce5e` |
| Native Codex thread | `01a08006-411d-7800-987e-928b6807828a` |
| Cleanup | `survivors: []`, including owned client-test process |

Harness now invokes isolated Vitest client replay after native checks. Exact child arguments: `node_modules/vitest/vitest.mjs run packages/client/src/components/__tests__/queue-roundtrip-integration.test.tsx -t "REAL FRAMES"`; child HOME is artifact directory; `PI_SEND_QUEUE_FRAMES` points to captured `browser-frames.jsonl`.

Client result: **1 passed, 16 intentionally unselected tests skipped** in `client-frame-recovery.log`. Replay consumes actual ordered WS frames through `useMessageHandler` and renders `ChatView`, not a parallel failure-frame predicate. Seeds optimistic card using real accepted nonce/text, verifies enqueue confirmation, Stop failure, empty snapshot, preserved failed card, functional Retry/Dismiss, no automatic duplicate send. Also consumes successful FIFO and committed-provider-failure frames, verifies one committed user message and no queue retry resurrection. Retry submission is spied at client send boundary; no extra live model turn sent by replay.

Native harness retains all original live checks: delegated pi/Codex answers, FIFO ordering, Stop cancellation, injected queued provider error, token/forwarded/non-loopback denial, forged-author rejection, operator-vs-delegated attribution, lifecycle denial, no implicit resume.

Delta artifact SHA-256:

```text
evidence.json             cb30c304c5558e7917dd24f5f7056e1d1dcf72e95f230470f0c90ceb441baadd
browser-frames.jsonl      6d293b093efad48de5e6488ab2acf54d8bddb74d394477eea92c8ea98f7e1e74
client-frame-recovery.log aa40383b2918493855e35dcb960cff9bef430c8304837ecbb31d191e41e7ce2c
```

### Residuals

- FIFO remains unbounded and in memory. No resource-limit implementation or crash-durable execution added.
- Failure after user-message commit retains committed chat/error history, not a recreated queue card; automatic retry would risk duplicate delivery. Existing non-queue recovery unchanged.
- No full build restart or repository-wide test rerun in delta. Original full-suite/lint residuals remain documented above; final focused/type-check results recorded below.
- All changes remain uncommitted in authorized worktree.

### Final Validation After Restoration

Final scoped old+new regression command (includes captured native frames; no model calls):

```bash
HOME=$(mktemp -d /tmp/send-delta-unit-XXXXXX) PI_SEND_QUEUE_FRAMES=/tmp/codex-runtime-browser-send-yXamgX/browser-frames.jsonl node_modules/.bin/vitest run packages/client/src/components/__tests__/queue-roundtrip-integration.test.tsx packages/client/src/lib/__tests__/event-reducer-queue.test.ts packages/client/src/components/__tests__/codex-runtime-controls.test.tsx packages/server/src/runtime/__tests__/codex-adapter.test.ts packages/server/src/__tests__/delegated-send-prompt.test.ts packages/server/src/__tests__/delegated-bridge-spawn-only.test.ts packages/server/src/__tests__/spawn-authz.test.ts packages/server/src/__tests__/spawn-authz-adversarial.test.ts packages/extension/src/__tests__/queue-tracker.test.ts > /tmp/send-delta-core-final.log 2>&1
```

**PASS: 171 tests, 9 files, zero skipped**, exit 0, 10.88s. Final code includes corrected type narrowing in real-frame test. Actual client-handler/reducer regression, Retry/Dismiss UI, native-frame replay, adapter FIFO/cancellation, delegated-send authorization, loopback/forwarded/token matrix, pi queue tracker, and original composer controls pass.

Expanded compatibility attempts are **not claimed green**. Exact commands:

```bash
HOME=$(mktemp -d /tmp/send-delta-unit-XXXXXX) PI_SEND_QUEUE_FRAMES=/tmp/codex-runtime-browser-send-yXamgX/browser-frames.jsonl node_modules/.bin/vitest run packages/server/src/runtime/__tests__ packages/server/src/__tests__/delegated-send-prompt.test.ts packages/server/src/__tests__/delegated-bridge-spawn-only.test.ts packages/server/src/__tests__/spawn-authz.test.ts packages/server/src/__tests__/spawn-authz-adversarial.test.ts packages/server/src/__tests__/build1b-rest-closure.test.ts packages/server/src/__tests__/build1b-ws-closure.test.ts packages/server/src/__tests__/build1b-fix3-send-prompt-authz.test.ts packages/client/src/components/__tests__/queue-roundtrip-integration.test.tsx packages/client/src/components/__tests__/codex-runtime-controls.test.tsx packages/client/src/lib/__tests__/event-reducer-queue.test.ts packages/client/src/hooks/__tests__/useMessageHandler.snapshot-replace.test.tsx packages/client/src/hooks/__tests__/useMessageHandler.replay-reset.test.tsx packages/client/src/hooks/__tests__/usePendingPromptTimeout.test.ts packages/extension/src/__tests__/queue-tracker.test.ts > /tmp/send-delta-restored-tests.log 2>&1
HOME=$(mktemp -d /tmp/send-delta-unit-XXXXXX) PI_SEND_QUEUE_FRAMES=/tmp/codex-runtime-browser-send-yXamgX/browser-frames.jsonl node_modules/.bin/vitest run packages/server/src/runtime/__tests__ packages/server/src/__tests__/delegated-send-prompt.test.ts packages/server/src/__tests__/delegated-bridge-spawn-only.test.ts packages/server/src/__tests__/spawn-authz.test.ts packages/server/src/__tests__/spawn-authz-adversarial.test.ts packages/server/src/__tests__/build1b-rest-closure.test.ts packages/server/src/__tests__/build1b-fix3-send-prompt-authz.test.ts packages/client/src/components/__tests__/queue-roundtrip-integration.test.tsx packages/client/src/components/__tests__/codex-runtime-controls.test.tsx packages/client/src/lib/__tests__/event-reducer-queue.test.ts packages/client/src/hooks/__tests__/useMessageHandler.snapshot-replace.test.tsx packages/client/src/hooks/__tests__/useMessageHandler.replay-reset.test.tsx packages/client/src/hooks/__tests__/usePendingPromptTimeout.test.ts packages/extension/src/__tests__/queue-tracker.test.ts > /tmp/send-delta-focused-final.log 2>&1
```

- First expanded run: **308 passed, 2 failed, 1 opt-in native live test skipped**; 20 files passed, 1 failed, 1 skipped; exit 1. `build1b-ws-closure.test.ts:201` and `:299` fail to observe shutdown frame after fixed 250ms waits. Named recovery tests pass.
- Second expanded run: **290 passed, 2 failed, 1 opt-in native live test skipped**; 19 files passed, 1 failed, 1 skipped; exit 1. `runtime-ingress.test.ts:151` exceeds 5000ms test deadline; following `:169` sees two `createAdapter` calls instead of one. Named recovery tests pass. This file passed first expanded run.
- Both expanded runs overlap type-check work. Scheduling sensitivity remains possible, not proven. No shutdown/runtime-ingress production or test changes made to chase these failures. Final scoped run executes without concurrent lint and passes. Failure logs preserved, not hidden by narrower final selection.

Type-check commands:

```bash
HOME=$(mktemp -d /tmp/send-delta-lint-XXXXXX) npm run lint > /tmp/send-delta-lint.log 2>&1
HOME=$(mktemp -d /tmp/send-delta-lint-XXXXXX) npm run lint > /tmp/send-delta-lint-final.log 2>&1
git diff --check
```

First type-check finds original 23 diagnostics plus one new unknown-`followUp` array access in replay test. Fixed only new diagnostic with `Array.isArray`. Final type-check exits 2 with **exactly 23 diagnostics**, byte-for-byte equal diagnostic lines to original `/tmp/send-lint.log`; **zero new diagnostics**. Existing composer/translator types and duplicate `resurrectionSweepMs` declarations remain untouched. `git diff --check`: **PASS**.
