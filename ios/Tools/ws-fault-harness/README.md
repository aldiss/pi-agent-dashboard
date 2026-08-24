# ws-fault-harness

Drives the real `DashboardStore` against a WebSocket server that breaks on purpose,
and checks what the **server actually received** — not what the client believes it
sent. Command line only: no simulator, no signing, no network, no npm install.

```bash
./run-reconnect-check.sh          # drop + reconnect  (~35s)
./run-reconnect-check.sh stall    # silent half-open  (~2min)
```

Exit 0 = every connection re-subscribed the open chat. Exit 1 = it didn't, or the
fault never triggered a reconnect (a run that proves nothing fails loudly rather
than passing quietly).

## Why it exists

Build 1 froze the chat after any reconnect. The store restarted the stream and
re-issued `subscribe` on the next line, racing `client.connect()`; the send reached
the actor before it had a socket, threw `.notConnected`, and was discarded. The app
looked connected, the session list kept updating, and the open chat received nothing
— a reply in flight sat on "thinking…" forever and the next message stayed "1 queued".

Measured on build 1: 4 reconnects → 4 `session_view` frames, 1 `subscribe`. Fixed in
`da6cd5f`: 4 of 4.

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
| `probe/Driver.swift` | Connects, opens a chat, optionally simulates a foreground return (`revalidate()`), reports phase transitions |
| `probe/AuthCookieStoreStub.swift` | Keychain stand-in — the real one would prompt from a CLI |
| `run-reconnect-check.sh` | Builds the throwaway package, runs the fault, asserts connections == subscribes |

## Verifying the check itself

It has been shown to fail: reverting `DashboardStore.swift` to `da6cd5f~1` makes it
report `4 connections / 1 subscribe` and exit 1. Do that again after changing it —
a check that has never failed is not evidence.
