# ws-fault-harness

Drives the real `DashboardStore` against a WebSocket server that breaks on purpose,
and checks what the **server actually received** — not what the client believes it
sent. Command line only: no simulator, no signing, no network, no npm install.

```bash
./run-reconnect-check.sh                       # drop + reconnect (~35s)
./run-reconnect-check.sh stall                 # silent half-open (~2min)
./run-reconnect-check.sh send-loss             # unacknowledged send becomes failed
./run-reconnect-check.sh send-recover          # late echo recovers row + banner
./run-reconnect-check.sh send-partial-recover  # other failed send keeps its banner
./run-reconnect-check.sh reset-replay           # seq 100 → reset → replay 1/live 2
./run-reconnect-check.sh prompt-cycle           # request → answer B → server dismiss
./run-reconnect-check.sh prompt-duplicate       # recursive second id renders/submits once
./run-reconnect-check.sh queue-loss             # connected/no ack → slow failure
./run-reconnect-check.sh queue-drop             # socket close → failure before deadline
./run-reconnect-check.sh queue-recover          # late bridge ack recovers card + banner
./run-reconnect-check.sh model-cache            # two calls → one wire request, cache stays loaded
./run-reconnect-check.sh model-empty            # empty catalogue reaches loaded state
./run-reconnect-check.sh send-same-recover       # ack A cannot clear same-value draft B
./run-reconnect-check.sh send-edit-recover       # late ack preserves operator whitespace edit
```

Exit 0 = the selected invariant holds. Exit 1 = behavior failed, or the fault never
exercised the expected path. A run that proves nothing fails loudly rather than
passing quietly.

## Why it exists

Build 1 froze the chat after any reconnect. The store restarted the stream and
re-issued `subscribe` on the next line, racing `client.connect()`; the send reached
the actor before it had a socket, threw `.notConnected`, and was discarded. The app
looked connected, the session list kept updating, and the open chat received nothing
— a reply in flight sat on "thinking…" forever and the next message stayed "1 queued".

Measured on build 1: 4 reconnects → 4 `session_view` frames, 1 `subscribe`. Fixed in
`da6cd5f`: 4 of 4.

Later modes cover composed failures found after that fix: a half-open socket accepts
bytes locally while the server receives nothing; full replay must preserve the failed
local row; a late wrapped echo must recover it without hiding another failed send;
`session_state_reset` must clear the old sequence namespace; and a PromptBus request
must remain visible until its answer receives an authoritative dismiss.

## Why the shape

- **The server's frame log is the evidence.** A client-side assertion would have
  passed on the broken build: the store did call `subscribe`, and `safeSend` reported
  nothing when it was dropped.
- **The store is symlinked, never copied.** A copy drifts, and the check silently
  stops measuring shipping code.
- **`close` and `stall` are different failures.** `close` sends a close frame — the
  socket reports its own death. `stall` holds the TCP connection open and ignores
  everything, which is what a cell-network NAT timeout or a WiFi→5G handoff does:
  `receive()` never errors, so only the keepalive catches it (~32s).
- **The keychain is stubbed, the store is not.** `AuthCookieStoreStub` supplies an
  unexpired JWT so the cookie gate opens. Auth is not what's under test.

## Files

| file | purpose |
|---|---|
| `ws-fault-server.mjs` | Dependency-free WS server; modes `alive` / `close` / `destroy` / `stall`; logs every client frame to JSONL |
| `probe/Driver.swift` | Connects, opens chat, sends fault-window probes, reports phase/delivery/content state |
| `probe/AuthCookieStoreStub.swift` | Keychain stand-in — real store would prompt from CLI |
| `run-reconnect-check.sh` | Builds throwaway package, runs selected fault, asserts server + store invariants |

## Verifying the check itself

It has been shown to fail: reverting `DashboardStore.swift` to `da6cd5f~1` makes it
report `4 connections / 1 subscribe` and exit 1. Do that again after changing it —
a check that has never failed is not evidence.
