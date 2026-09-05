# B10 root-cause diagnosis — 2026-09-05

Investigation window: approximately 20:27–20:40 Europe/Copenhagen (18:27–18:40 UTC). Gateway timestamps below are UTC.

## 1. Verdict

**I do not know yet what terminates the operator's iPhone connection. No on-device close/cancellation trace was obtained.**

There is a named, reproducible *conditional* defect: **URLSession's default 1 MiB receive limit rejects an oversized uncompressed message locally.** However, the evidence does **not** establish that this condition occurred on the operator's device. Calling it the B10 root cause would currently overstate the evidence.

Key discriminating results:

- **The same production Cloudflare hostname delivered a 1,453,441-byte uncompressed text snapshot successfully**, followed by live traffic, and remained open until my planned close after 15 seconds. This falsifies a blanket approximately 1 MiB Cloudflare message ceiling on the tested route.
- **The original, pre-fix DashboardClient received the production snapshot and remained connected through that tunnel from macOS.** Its active foreground probe returned true. No DashboardStore or reconnect race was involved in this isolated-client test.
- **Native URLSession on this Mac offers and negotiates `permessage-deflate`.** It received a 1,428,397-byte logical snapshot with `maximumMessageSize == 1,048,576`. Thus “URLSession cannot negotiate compression” is demonstrably false as a universal statement. The iPhone's negotiation remains unmeasured.
- The real original client survived until a controlled keepalive timeout at **32.512 seconds**, not milliseconds.
- Both new flap fault paths ran against real sockets and the original client. Abrupt destruction produced `lastClose=abrupt`; injected close **1012 produced reported code 1005**, consistently. A separate Node client received the actual 1012. The existing orderly harness assertion therefore **fails** on this platform; it is not a passing test.

**One next measurement:** capture one actual on-device flap as a per-socket lifecycle trace, including local cancellation call sites and the full receive error, not merely `lastClose`. Section 7 specifies the fields and mutually different outcomes.

## 2. Provenance and constraints

- Live file verified: `~/.pi/dashboard/gateway.log`, initially 8,260,905 bytes, modified September 5. Native burst reproduced at lines 53331–53340.
- Stale file verified by metadata only: `~/.pi/dashboard/server.log`, modified August 20. Its contents were not used.
- `/api/health` and process command line agree: PID **35779**, production release **2d84120c5e245d8b61397f65730cdca40003fda9**, port 8000. `origin/main` resolves to that commit.
- Production `browser-gateway.ts` on disk and `git show origin/main:packages/server/src/browser-gateway.ts` have identical SHA-256: `5677f9ebfd2500d71be7a9c6519cc4c2ae8c888afa04021faffbf82a63be7143`.
- iOS diagnosis uses original revision **eeb1467a857538db982e3e578a5e6428ff3162c2**. Its `DashboardClient.swift` SHA-256: `072b93bf3686b5a19170bce086f31e48cbec6e712d706f7de73ba3ff8c63d6cb`. iOS source line references below mean this revision unless otherwise specified.
- **Concurrent external changes occurred during diagnosis.** Another job committed `de8247c7` at 20:32:49, adding a 16 MiB receive limit and root-cause commentary, then `c16cff75` at 20:33:26, committing the fault-server changes. I did not make, revert, commit, or otherwise alter these changes. Tests of the original client explicitly read `git show eeb1467a:...`, avoiding contamination by the new limit.
- Test host: macOS **26.6.2**, build **25G83**. These are not executions on the operator's iPhone. `PiDashboard/43` in a user agent does not establish the device binary's source hash.
- No source files were edited. No release/build/install, commit, push, tag, archive, production restart, or server mutation was performed. Diagnostic WebSocket connections were read-only; fault-server subscriptions targeted the local fixture only.
- Authenticated probes used a short-lived in-memory token signed with the existing local dashboard configuration, matching a configured operator selector. No credentials were printed or written to this report. This tests operator visibility, not the exact credential installed on the phone.
- No new source, trace, or harness workspace files were written. Swift source was supplied through stdin; fault-server `--trace=/dev/null`; outputs were captured by the command interface. This report is the sole intentionally created file. Normal interpreter/system caches are not test artifacts.

Counterfactual for provenance: mismatched PID/commit/hash would invalidate claims about the running implementation; those checks agreed. An unchanged checkout would not show the two concurrent commits; it did.

## 3. Production transport measurements

### A. Snapshot size and compression

Node `ws` was loaded from the running release's dependencies. Probes explicitly selected `perMessageDeflate: false` or `true`, recorded upgrade headers, parsed the received snapshot, continued consuming messages, then initiated a code-1000 close at a scheduled deadline.

| Probe | Negotiated extension | Snapshot bytes | Sessions | Snapshot received after | Total messages | Client-measured lifetime / end |
|---|---|---:|---:|---:|---:|---|
| Loopback, compression disabled | none | 1,428,421 | 1643 | 712 ms | 197 | 8.321 s; planned close 1000 |
| Loopback, compression enabled | permessage-deflate | 1,428,419 | 1643 | 705 ms | 197 | 8.002 s; planned close 1000 |
| Production tunnel, compression disabled | none | **1,453,441** | 1643 | 1590 ms | 199 | **15.314 s; planned close 1000** |
| Production tunnel, compression enabled | permessage-deflate | 1,453,415 | 1643 | 389 ms | 199 | 15.430 s; planned close 1000 |

All snapshots were text, not binary. Tunnel upgrade responses were HTTP 101 with `server: cloudflare`. Compression-off had no negotiated WebSocket extension. The server code sends the serialized snapshot in `ws.send(payload)`; no application-level chunking was introduced by the probe.

For compressed loopback, cumulative socket bytes read at snapshot completion were 180,158, versus 1,428,560 without compression. These counters include HTTP/framing and possibly adjacent bytes: **they are not exact per-frame wire lengths**. Successful negotiation plus substantially smaller cumulative traffic establishes that compression actually operated.

**If a blanket approximately 1 MiB tunnel limit were killing this snapshot**, the compression-off tunnel connection would fail before receiving the complete 1,453,441-byte snapshot, or terminate unexpectedly afterward. It instead delivered the snapshot and 198 additional messages before my explicit close. This is a positive transmission control, not inference from an empty log.

Scope: this rules out the proposed generic ceiling on the tested production route. It does not prove that every Cloudflare edge, phone network path, or client-specific policy behaves identically. No iPhone-side tunnel capture was available.

### B. Original native client against production

Executed original `DashboardClient` and required Kit sources from `eeb1467a` through the Swift interpreter. No maximum-message-size override. Consumer continuously drained the stream. A concurrent foreground ping ran at four seconds; a separate task intentionally disconnected at eight seconds.

| Endpoint | Snapshot | Foreground probe | State before planned disconnect | Stream lifetime | Frames | lastClose |
|---|---|---|---|---:|---:|---|
| `http://127.0.0.1:8000` | 1643 sessions after 0.076 s | true | connected | 8.379 s | 199 | nil |
| `https://dash.deckdeckshare.com` | 1643 sessions after 0.356 s | true | connected | 8.155 s | 197 | nil |

Gateway connect references: `gateway.log:53376` and `gateway.log:53378`, UA `B10-original-DashboardClient`.

**If the original client invariably failed on today's production snapshot**, these streams would finish before the intentional disconnect, fail decoding the snapshot, or fail the active liveness check. None happened. This is a counterexample on macOS, not exoneration of an iOS-specific failure or DashboardStore race.

### C. Subscription and principal scope

Exact server source:

- `packages/server/src/browser-gateway.ts:177`: enables permessage-deflate.
- `:501`: constructs the snapshot from all sessions and non-empty orders.
- `:550`: sends it at connection, before any session subscribe is required.
- `:444` / `:453`: filters outgoing messages for the bound principal when cell access is enabled.
- `:489`: sends serialized JSON.

The scope filter **fires in a real control**: an authenticated diagnostic identity without operator grants received a **54-byte, zero-session snapshot**; a configured operator identity received **1643 sessions / approximately 1.43 MB**. Thus “every client receives the same snapshot” requires equal visibility, not merely equal hostname. Actual phone/browser principals were not inspected.

Counterfactual: without effective principal filtering, changing only the diagnostic principal would not reduce the snapshot to zero visible sessions. It did. No evidence establishes that principal asymmetry explains B10.

### D. Which 4 MiB limit?

At the exact server commit, `browser-gateway.ts:391` defines a default **buffered-output threshold**, and `:465` drops a send when `ws.bufferedAmount` already exceeds it. This is not an outbound single-message ceiling. The WebSocketServer construction does not set `maxPayload` there.

The original iOS `Chat/PayloadCap.swift:13` separately defines a **4 MiB post-receive decode budget**. `DashboardClient.swift:313` skips oversized decoded data; it does not close the socket in that branch.

Counterfactual: a true outbound per-message rejection would compare the message's size and reject/close at that boundary. These inspected branches instead check buffered output or skip client decoding. Neither comparison rules out URLSession's independent transport limit.

## 4. URLSession ceiling: reproduced, but conditional

A fresh native `URLSessionWebSocketTask` reports `maximumMessageSize=1048576`. The original `DashboardClient.swift:131` creates that task without overriding the property.

Controlled loopback fixture: identical valid JSON text message, **1,200,067 bytes**, with an empty sessions snapshot plus padding. Only server compression and client limit varied.

| Compression negotiated | Client limit | Result |
|---|---:|---|
| none | 1,048,576 | Receive throws `NSPOSIXErrorDomain`, code **40**, “Message too long”; local raw close code **0** |
| none | 4,194,304 | Complete message received |
| permessage-deflate | 1,048,576 | Complete message received |
| permessage-deflate | 4,194,304 | Complete message received |

Server recorded the native request offering **`Sec-WebSocket-Extensions: permessage-deflate`**. With server compression disabled it negotiated none; with compression enabled it negotiated permessage-deflate. A separate live-production raw URLSession probe also received **1,428,397 bytes** while reporting the default 1 MiB limit and negotiated permessage-deflate.

An additional connection-ID-labelled control removed ambiguity about direction:

```text
SERVER_SENT /cap-1048576 bytes=1200067 compression=none
SERVER_CLOSE_RECEIVED /cap-1048576 1009
CLIENT cap=1048576 ERROR=NSPOSIXErrorDomain/40 raw=0

SERVER_SENT /cap-4194304 bytes=1200067 compression=none
CLIENT cap=4194304 RECEIVE_OK; planned cancel1000
SERVER_CLOSE_RECEIVED /cap-4194304 1000
```

**Causal result:** the small uncompressed receive limit caused a **client-initiated** 1009 close. Raising only that limit allowed the same message. If this limit were irrelevant, changing it would not switch failure to success. Both outcomes were observed.

**Diagnostic trap:** at the failing client, the supplied classifier would call raw zero “abrupt,” despite the server receiving a client-originated 1009. Therefore `lastClose=abrupt` does **not** establish that Cloudflare/network/server initiated the failure. The full NSError is load-bearing.

**Why this is not yet the phone root cause:** native compression works in the measured environment; the original client works through the production tunnel here; the iPhone's negotiated extension, effective task limit, actual snapshot size, and raw receive error were not captured. These missing facts cannot be replaced by the new commit's commentary.

The observed compressed-message behavior is reported as a measurement, not generalized into an undocumented cross-platform limit algorithm.

## 5. Real fault-harness results and controls

The shell wrapper creates a throwaway package, source copies/symlinks, build products, and log files (`run-reconnect-check.sh:53`, `:91`, `:108`). To respect the one-file constraint, **the wrapper itself was not executed**.

Instead, the existing fault server was run unmodified with `--trace=/dev/null`, and its new fault modes were exercised using the **exact `runSocketFlap` driver function** with original `DashboardClient` and dependencies supplied through stdin. No substitute client was used for the following five-cycle results. The direct driver sleeps two seconds between cycles; it does **not** exercise DashboardStore's exponential backoff.

### Abrupt `flap`

Server: `--mode=destroy --after=0.25 --closeCode=1012`.

```text
[client 0.29s] flap cycle=1 frames=2 lastClose=abrupt
[client 2.67s] flap cycle=2 frames=2 lastClose=abrupt
[client 4.93s] flap cycle=3 frames=2 lastClose=abrupt
[client 7.29s] flap cycle=4 frames=2 lastClose=abrupt
[client 9.59s] flap cycle=5 frames=2 lastClose=abrupt
```

Server trace: five accepts, five subscribes, five `FAULT_destroy`, at most one live socket. Accept-to-fault **0.25–0.26 s**; accept-to-accept **2.27–2.39 s**. Client exited zero. This reproduces the symptom's timing with a known externally injected cause; timing alone cannot identify the production cause.

### Orderly `flap-orderly`

Server: `--mode=close --after=0.25 --closeCode=1012`.

```text
[client 0.28s] flap cycle=1 frames=2 lastClose=orderly code=1005 reason=none
[client 2.57s] flap cycle=2 frames=2 lastClose=orderly code=1005 reason=none
[client 4.83s] flap cycle=3 frames=2 lastClose=orderly code=1005 reason=none
[client 7.27s] flap cycle=4 frames=2 lastClose=orderly code=1005 reason=none
[client 9.62s] flap cycle=5 frames=2 lastClose=orderly code=1005 reason=none
```

Server trace: five accepts/subscribes and five `FAULT_close` records explicitly carrying **1012**, each 0.25 s after accept; at most one live socket. Accept-to-accept **2.26–2.44 s**. The server forcibly destroys each socket approximately 0.20 s after sending close, explaining why server-observed lifetime can exceed client receive-loop lifetime.

**The orderly code-preservation assertion fails.** Reapplied the existing `assert_flap_close_kind` function to the captured output through process-substitution streams:

| Evidence / expectation | Exit |
|---|---:|
| Actual abrupt / expected abrupt | 0 |
| Same abrupt / deliberately wrong orderly | 1 |
| Actual orderly 1005 / harness expected 1012 | **1** |
| Same orderly / deliberately wrong abrupt | 1 |

Independent live controls against the same fault server:

| Server sends | Node `ws` receives | Native URLSession reports |
|---:|---:|---:|
| 1000 | 1000 | 1000 |
| 1012 | 1012 | **1005** |

The control fires in both directions: ordinary code 1000 survives, while 1012 does not survive into this native API observation. This localizes the discrepancy away from the server's chosen code, without claiming a particular internal Foundation implementation bug. Do not use the raw task code as guaranteed verbatim wire evidence.

### Real keepalive control

Original client against existing server `--mode=stall --after=0.25`, no foreground calls:

```text
KEEPALIVE_BOUNDARY at0.45=false at31.99=false at32=true
STALL_REAL_CLIENT elapsed=32.511677980422974 frames=1
state=failed("keepalive timeout") lastClose=nil
```

Server trace: accept at relative 5.35 s; `FAULT_stall` at 5.60 s; an actual `rx_ws_ping_stalled` at 27.47 s. Thus keepalive was genuinely exercised, not simply absent from a healthy run.

Source: `KeepaliveMonitor.swift:32`, `:58`; `DashboardClient.swift:273`. **Passive keepalive is ruled out as the subsecond killer for this implementation under a stable clock.** A keepalive explanation would require this path to fire in the subsecond window; its firing control instead takes approximately 32 seconds. This does not rule out the separate two-second foreground liveness probe.

## 6. Logs, backoff, and the race hypothesis

### Pairing cannot be made exact from these counters alone

Recomputed adjacent-connect/next-disconnect candidates for September 4–5, excluding labelled B10 probes:

| UA group | Candidate pairs | Under 1 second | Mean | Longest | Unambiguous total-1 → remaining-0 pairs |
|---|---:|---:|---:|---:|---:|
| Native | **117** | **88** | **19.712829 s** | **323.839 s** | **0** |
| Browser | 269 | 14 | 368.861271 s | 7144.615 s | 165 |

Native numbers reproduce the operator's calculation. Browser counts reflect later live records. These are **candidate lifetimes**, not identity-exact native measurements.

Concrete positive control for pairing ambiguity: my uncompressed tunnel probe connected at `gateway.log:53370`, **18:35:26.550Z**. The next disconnect, `:53371`, is at **18:35:32.145Z**, just 5.595 s later. But that identified probe was still receiving and only closed at its planned 15-second deadline, corresponding to the later disconnect at **18:35:41.637Z** (`:53373`). The intervening disconnect belonged to another client. Scalar counts remain compatible with either identity assignment until additional evidence is supplied.

The representative native burst remains real, including 228/233/300/437/300 ms adjacent gaps at lines 53331–53340. The counters alone cannot prove which one of two connected clients each disconnect removed.

### Admission control did not re-verify

`rg -ni 'admission|slot|bump|evict|principal' ~/.pi/dashboard/gateway.log` returned **zero hits over the entire live file**, not the claimed 32. A separate connection-event grep had 430 selected connection records, but that is not a positive control for admission instrumentation.

Therefore **I do not claim to have independently ruled out admission from absent log events**. No production admission/bump was intentionally triggered. Source inspection shows no close in the snapshot/filter/send path; the gateway's socket-error termination is at `browser-gateway.ts:539`. Neither fact supplies the missing admission logging control.

### Flat cadence is conditional evidence, not a snapshot trace

- `Protocol/Messages.swift:82` sets connected phase for a received message, but resets attempts only for `sessionsSnapshot`.
- `DashboardStore.swift:397` increments attempts and sleeps `min(2^attempt, 30)`.
- `DashboardStore.swift:514` applies the connection transition to store state.
- `DashboardStore.swift:398` does not schedule ordinary retries before the dashboard has ever been entered.

For **one persistent store using this exact revision, reconnecting only through that scheduler**, flat approximately two-second waits support a snapshot reset on each cycle. Without resets the waits must grow. However, gateway timestamps do not prove store identity, trigger identity, or which source revision build 43 runs.

This exposes a contradiction that must not be hidden: **if URLSession rejects every initial snapshot before delivery, those snapshots cannot simultaneously reset the store's backoff**. A pure repeated pre-snapshot size failure does not explain the stated snapshot-only flat-backoff model without additional evidence about another trigger, instance, version, or later oversized message. None was measured on the phone.

No-subscribe logging is non-discriminating and was not used as evidence. Both healthy and failing production paths can be silent there. In contrast, the fault server logs subscribes and recorded them on every flap cycle.

### Connect/revalidate race: possible overlap, not established cause

Relevant original source:

- `DashboardStore.swift:337`: `startStream` cancels `consumeTask`, then launches a task that awaits `client.connect`.
- `:354`: only a non-cancelled consumer schedules reconnect after stream completion.
- `:403`: reconnect sleep checks cancellation before calling `startStream` at `:412`.
- `:432`: revalidation guards concurrent revalidations, awaits a captured-socket ping, then may call `startStream` at `:456`.
- `DashboardClient.swift:120`: `connect` first calls `disconnect`; `:142` cancels the old socket with goingAway.
- `:160`: a pong on a superseded socket cannot certify the new one.
- `:240`: a superseded receive loop returns **before** recording `lastClose`.
- `PiDashboardApp.swift:58`: foreground revalidation is called on a transition into active, not by a repeating timer in that call site.

These paths permit a stale foreground probe result to request replacement around a reconnect. But they also contain cancellation/identity guards, and there is no measured stream of on-device foreground triggers proving a self-sustaining loop. **The race is neither proved nor ruled out.** The isolated DashboardClient production test does not exercise DashboardStore and cannot exonerate it.

Counterfactual: if supersession causes a particular flap, a local `disconnect`/cancel with that socket identity and caller must precede its disappearance. If receive failure occurs while that socket is still current, before any local cancellation, that instance is not explained by superseding it. Gateway connect/disconnect timing and a stale `lastClose` do not distinguish those outcomes.

## 7. Single next decisive measurement

**Capture one actual on-device flap as a socket-ID-correlated lifecycle trace, beginning before connect and ending after the retry decision.** Use debugger/logpoints or a subsequent diagnostic-only build; neither was installed or changed here.

The one trace must include:

1. Device build/source identity; store instance ID; socket/task ID; monotonic timestamps.
2. `startStream` caller: initial connect, scheduled reconnect, or foreground recovery; attempt and phase.
3. Task's effective `maximumMessageSize`; negotiated `Sec-WebSocket-Extensions` from upgrade response.
4. Successful receive byte counts/types and the **actual snapshot apply/backoff-reset event** for that socket.
5. Every local disconnect/cancel with socket ID and caller, **including superseded tasks**, before the identity guard suppresses evidence.
6. First receive failure: NSError domain/code and underlying error, raw close code/reason, and whether the failing socket is still current. Capture before clearing `task`.

Decision table:

| Actual trace | What it establishes |
|---|---|
| Local cancel/supersession on socket S before its loss, with foreground/reconnect caller | Self-inflicted replacement for that flap; identifies which race/lifecycle path to reproduce |
| Current S fails with message-too-long, relevant size/limit/negotiation mismatch, no preceding app cancellation | Native receive-limit failure, not a Cloudflare-originated size rejection |
| Current S fails before any local cancellation with a different transport/peer-close error | Supersession hypothesis false for that flap; investigate reported transport error/peer close |
| No successful snapshot apply and attempts still repeatedly restart at one | The assumed single-store/scheduler/source model is false; inspect the recorded instance and caller changes |

This capture settles the immediate close-initiator/size-versus-supersession question. A generic external transport failure may still require hop-specific evidence to identify its ultimate cause; no single generic “abrupt” result can name Cloudflare versus another peer.

**Surfacing `lastClose` is cheap and useful, but not decisive by itself.** It is not reset on connect, local disconnect does not populate it, superseded loops deliberately skip it, and observed native 1012 loses its exact wire code. The size-limit control even produced `raw=0` while the native client sent 1009. Surface the full receive error plus a per-socket local-cancel record alongside it. Never treat a stale orderly/abrupt label as attribution.

## 8. Explicit exclusions and unfinished work

**Ruled out within measured scope:** generic approximately 1 MiB Cloudflare ceiling on the tested route; universal inability of URLSession to negotiate permessage-deflate; passive keepalive as this source's subsecond killer; server 4 MiB buffered-output threshold as evidence that a native message is safe.

**Not ruled out:** iPhone-specific native size/negotiation behavior, a larger subsequent message, store/lifecycle supersession, another client/network-specific transport fault, or admission by the originally claimed log control. None is named as the incident cause.

Not run or unavailable:

- No operator-device capture, device binary verification, or on-device reproduction.
- No full shell-wrapper harness run, because it creates multiple files/build products. Both new fault-mode bodies and exact client driver ran as described; full-wrapper success is not claimed.
- No `revalidate-idle`, `revalidate-halfopen`, full `session-lifecycle`, or forced DashboardStore reconnect/revalidate race run. Do not infer their results from isolated-client tests.
- Packet capture attempted via `/usr/sbin/tcpdump -i lo0`; refused with **BPF permission denied**. No privileged capture was performed.
- An initial raw URLSession experiment stopped consuming after its first snapshot and waited for a ping callback; it did not complete and was terminated. A second bounded version hit its watchdog. These are **invalid liveness tests** and are not counted as failures of production. The later continuously draining original-client probes completed with positive pong controls.
- An initial in-memory source assembly failed compilation because required model dependencies were omitted. Dependencies were then included; the recorded original-client runs compiled/interpreted and exited successfully.
- No proof of the claimed 32 admission-related live-log hits; actual whole-file result was zero.
- No claim that the concurrent 16 MiB change fixes the operator's device. Its universal compression assertion conflicts with direct measurements here.

## 9. Documentation cross-checks

Official documentation fetched read-only during diagnosis:

- Apple `maximumMessageSize` documentation: receive calls fail at the configured receive limit, including continuation-frame bytes. Source: `https://developer.apple.com/tutorials/data/documentation/foundation/urlsessionwebsockettask/maximummessagesize.json`.
- Cloudflare ordinary WebSocket proxy documentation did not establish the proposed approximately 1 MiB message ceiling. Source: `https://developers.cloudflare.com/network/websockets/index.md`.
- Current Cloudflare **Workers** WebSocket documentation states a 32 MiB receive limit. That is a different product boundary and is **not** used as evidence for this tunnel. Source: `https://developers.cloudflare.com/workers/runtime-apis/websockets/index.md`.

Documentation absence does not rule out a limit. The successful **uncompressed production-tunnel transfer**, the **native size A/B failure/success**, and the **on-wire close controls** are the discriminating evidence in this report.
