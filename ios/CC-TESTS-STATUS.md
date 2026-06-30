# CC-TESTS-STATUS — cc-ios-tests session report

Supervised session (driver: **SwiftPilot**). Owner of the durable **e2e + contract
test suite** for the native iPhone pi-dashboard app. Author ≠ verifier: this session
BUILDS + OWNS the tests; the separate `cc-ios-build` session built the app;
SwiftPilot re-runs everything.

Working dir: `/Users/vdrobkov/Misc/Documents/Copilot/pi-agent-dashboard-ios-tests`
Branch: `feat/native-ios-tests` · Base: `dda5919`

---

## Acceptance gates (brief §3) — all PASS with REAL output

### Gate 1 — `swift test` green with EXPANDED coverage (≥ 51, all passing)

```
$ cd ios/PiDashboardKit && swift test
...
Test Suite 'All tests' passed at 2026-06-30 09:36:23.557.
	 Executed 108 tests, with 0 failures (0 unexpected) in 0.109 (0.125) seconds
```

**108 tests, 0 failures** (was 51 → **+57** authored by this session). No simulator.

Per-suite (seed = driver-authored, kept green; new = cc-ios-tests):

| Suite | Tests | Origin |
|---|---|---|
| ComposerLayoutTests | 6 | seed |
| DirectoryGroupingTests | 8 | seed |
| EventReducerTests | 16 | seed |
| GroupingTests | 11 | seed |
| ProtocolTests | 6 | seed |
| SessionDecodingTests | 4 | seed |
| **ContractE2ETests** | **6** | **new** — real captured `event_replay` decode + reduce invariants |
| **ProtocolRoundTripTests** | **20** | **new** — full encode/decode + forward-compat |
| **PatchAndModelContractTests** | **9** | **new** — partial-patch merge + model field parity |
| **GroupingPropertyTests** | **11** | **new** — grouping/filter algebra (partition/idempotence/…) |
| **ComposerModelPropertyTests** | **11** | **new** — composer hysteresis boundary sweep + model/theme |
| **Total** | **108** | 51 seed + 57 new |

### Gate 2 — fixture-capture harness runs read-only + writes a NEW real fixture

```
$ cd ios/qa-e2e && node capture-fixtures.mjs
[capture] host=http://localhost:8000 all=false maxEvents=80
[capture] health ok=true mode=production active=35
[capture] connecting (read-only) ws://localhost:8000/ws
[capture] ws open
[capture] snapshot: 310 session(s)
[capture] subscribe (read-only) → 019efa7a-cac9-7b1c-bf79-7c4b98f5a5cc (lastEntryCount≈0)
[capture]   event_replay batch: +0 (total 0, isLast=false)
[capture]   event_replay batch: +50 (total 50, isLast=false)
[capture]   event_replay batch: +18 (total 68, isLast=true)
[capture]   captured 68 event(s) from 019efa7a-cac9-7b1c-bf79-7c4b98f5a5cc (isLast=true)
[capture] event-type histogram: {"model_select":1,"message_start":5,"message_update":36,
          "message_end":9,"stats_update":9,"tool_execution_start":4,"tool_execution_end":4}
✓ captured 68 real event(s) → …/Fixtures/event-replay-sample.json
```

- Captured a REAL, complete (`isLast=true`) 68-event replay from the live operator
  dashboard. Event-type spread exercises the whole reducer (model_select, message
  stream, thinking, tool lifecycle, stats/context).
- **Read-only proven**: the harness's only WS sends are `subscribe`/`unsubscribe`,
  gated by a hard `SAFE_CLIENT_TYPES` allowlist that throws before the socket on
  anything else. No `send_prompt`/`abort`/`shutdown`/`force_kill`/`session_view`
  code path exists. Content scanned: 0 secret matches; benign repo-sync session.
- `ContractE2ETests` decodes this fixture through the full `ServerMessage` decoder
  and folds it through `ChatSessionState.reduce` (gate-2 fixture is consumed).
- Seed fixtures (`sessions-sample.json`, `health.json`, `ws-snapshot-sample.json`)
  left untouched — only the 2 new files added.

### Gate 3 — XCUITest e2e specs for ALL F1–F7 + run README

Authored in `ios/qa-e2e/PiDashboardUITests/` (12 test methods across F1–F7),
driving the app via TEST-CONTRACT §A identifiers in the hermetic `-uitest` fixture
mode (never touches a live session). **Type-check clean against the simulator
XCTest SDK** (the test-CC's pre-integration verification):

```
$ cd ios/qa-e2e/PiDashboardUITests && xcrun swiftc -typecheck -sdk <iphonesimulator> \
    -target arm64-apple-ios17.0-simulator -F <platform-frameworks> -I <platform-lib> *.swift
=== exit: 0 ===
errors: 0
warnings: 0
```

| File | Flows | Methods |
|---|---|---|
| `ConnectAndListUITests.swift` | F1 connect (+ unreachable error), F2 list/tier parity, F3 open session | 4 |
| `ComposerUITests.swift` | F4 hysteresis single-row⇄multiline + newline, F5 send gating | 3 |
| `BannerAndFiltersUITests.swift` | F6 connection banner, F7 search/folders/hide-stale | 5 |

They **compile + run after SwiftPilot integrates the app branch** (the XCUITest
target needs the simulator app). Run command + project.yml wiring: `qa-e2e/README.md`.

### Gate 4 — `ios/PARITY.md` populated across MVP surfaces

`ios/PARITY.md` exists: living PWA↔native↔test-id↔status table across Connect /
List / Lifecycle / Chat / Composer / Status / Theme + the deferred set, with a
✅/🟡/⛔ summary. Seeded from DESIGN §3/§4 + TEST-CONTRACT §B/§D.

---

## What's authored-but-pending-integration

- **All XCUITest e2e (F1–F7)** — authored + type-check clean; RUN is pending the
  app-branch merge (simulator target). README documents the exact `xcodebuild test`
  invocation + `project.yml` source-path wiring.
- **F6 positive path** (`testF6_BannerAppearsWhenReconnecting`) — needs a small
  build-session hook (see Reports to SwiftPilot). Authored; SKIPS with a clear note
  until the hook lands. F6-negative runs today.

## Reports to SwiftPilot (no owned code changed — reported, not patched)

1. **F6 reconnect hook (request).** XCUITest can't sever a hermetic fixture socket.
   To make the connection-banner POSITIVE path runnable, `DashboardStore` should
   enter `.reconnecting` when launched with a `-uitest-reconnecting` argument
   (mirrors the >3s disconnect). Spec is authored + gated on this; it skips, not
   fails, until wired. App-target change → cc-ios-build owned.
2. **No bugs found in owned core.** The seed core (`PiDashboardKit/Sources`) and the
   app target decode/reduce real captured payloads faithfully — 108 green tests incl.
   a real 68-event replay. Nothing required an owned-code fix.

## Ownership ledger (brief §4)

### Authored + owned by cc-ios-tests (this session)
| Artifact | Kind |
|---|---|
| `ios/qa-e2e/capture-fixtures.mjs` | read-only fixture-capture harness (new) |
| `ios/qa-e2e/README.md` | run/wiring docs (new) |
| `ios/qa-e2e/PiDashboardUITests/PiDashboardUITestCase.swift` | XCUITest base (new) |
| `ios/qa-e2e/PiDashboardUITests/ConnectAndListUITests.swift` | F1–F3 e2e (new) |
| `ios/qa-e2e/PiDashboardUITests/ComposerUITests.swift` | F4–F5 e2e (new) |
| `ios/qa-e2e/PiDashboardUITests/BannerAndFiltersUITests.swift` | F6–F7 e2e (new) |
| `ios/PiDashboardKit/Tests/…/ContractE2ETests.swift` | contract (new) |
| `ios/PiDashboardKit/Tests/…/ProtocolRoundTripTests.swift` | protocol round-trip (new) |
| `ios/PiDashboardKit/Tests/…/PatchAndModelContractTests.swift` | patch+model contract (new) |
| `ios/PiDashboardKit/Tests/…/GroupingPropertyTests.swift` | grouping property (new) |
| `ios/PiDashboardKit/Tests/…/ComposerModelPropertyTests.swift` | composer/model property (new) |
| `ios/PiDashboardKit/Tests/…/Fixtures/event-replay-sample.json` | REAL captured fixture (new) |
| `ios/PiDashboardKit/Tests/…/Fixtures/event-replay-sample.manifest.json` | capture provenance (new) |
| `ios/PARITY.md` | parity table (new) |
| `ios/CC-TESTS-STATUS.md` | this report (new) |

Commits (this session): `073e52d`, `b32a020`, `e867db2`.

### Adopted / expanded (driver-seeded scaffolding — read + kept green, NOT re-authored)
| Artifact | Treatment |
|---|---|
| `PiDashboardKit/Sources/**` (core: models, protocol, client, grouping, composer, reducer, theme) | read + critiqued; UNDER TEST; not modified (cc-ios-build owned) |
| `PiDashboardKitTests/{Composer,Grouping,DirectoryGrouping,EventReducer,Protocol,SessionDecoding}Tests.swift` | seed tests — adopted as floor; expanded in NEW files (no collision) |
| `PiDashboardKitTests/Fixtures/{sessions-sample,health,ws-snapshot-sample}.json` | seed fixtures — reused; left untouched |
| `PiDashboard/**` (app target) | drives the e2e; not modified (cc-ios-build owned) |
| `PiDashboard/UITests/PiDashboardSmokeUITests.swift` | build-CC smoke — NOT fought; extended beyond in qa-e2e |

### Boundary discipline
- Wrote **only** under `PiDashboardKit/Tests/**` (new files), `qa-e2e/**`, and the
  `ios/*.md` artifacts the brief names. Touched **no** `Sources/**`, no app target,
  no `EventReducer` internals test (covered behaviorally via the real-replay
  `ContractE2ETests` per brief §2.3).
- `swift test` kept green at every commit.

## Reproduce everything

```bash
# 1. Contract/unit/property suite (no simulator) — 108 green
cd ios/PiDashboardKit && swift test

# 2. Refresh the real event_replay fixture (read-only; needs a dashboard up)
cd ios/qa-e2e && node capture-fixtures.mjs

# 3. Type-check the XCUITest specs (pre-integration)
cd ios/qa-e2e/PiDashboardUITests && \
  xcrun swiftc -typecheck -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -target arm64-apple-ios17.0-simulator \
  -F "$(xcrun --sdk iphonesimulator --show-sdk-platform-path)/Developer/Library/Frameworks" \
  -I "$(xcrun --sdk iphonesimulator --show-sdk-platform-path)/Developer/usr/lib" *.swift

# 4. Full e2e (post-integration; see qa-e2e/README.md for wiring)
cd ios/PiDashboard && xcodegen generate && \
  xcodebuild test -project PiDashboard.xcodeproj -scheme PiDashboard \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3' \
  -only-testing:PiDashboardUITests
```
