# qa-e2e — durable e2e + contract test harness (native iPhone pi-dashboard)

Owned by the **cc-ios-tests** session. Two artifacts live here:

1. **`capture-fixtures.mjs`** — read-only fixture-capture harness (snapshots live
   dashboard payloads into the `PiDashboardKit` test bundle).
2. **`PiDashboardUITests/`** — the XCUITest e2e specs for flows **F1–F7**
   (TEST-CONTRACT §A/§B), driving the real SwiftUI app via accessibility ids.

The CLI-testable contract/unit/property suite lives in
`../PiDashboardKit/Tests/PiDashboardKitTests/` and runs with plain `swift test`
(no simulator). This README covers the two simulator-/network-touching pieces.

---

## 1. Fixture-capture harness — `capture-fixtures.mjs`

Zero dependencies (Node ≥ 22 built-in global `fetch` + `WebSocket`). Snapshots
live-dashboard payloads so the Swift contract tests decode the server's REAL
byte-shapes.

### SAFETY — read-only against a LIVE operator dashboard
- The ONLY WS messages it emits are `subscribe` / `unsubscribe`, gated by a hard
  allowlist (`SAFE_CLIENT_TYPES`). Any other type throws **before** the socket.
- There is no code path that can send `send_prompt` / `abort` / `shutdown` /
  `force_kill` / `session_view` / any mutation.
- `subscribe` only asks the server to replay a session's event log to *this*
  socket — it does not touch the session, the unread bit, or the operator UI.

### Run

```bash
cd ios/qa-e2e

# capture a real event_replay → Fixtures/event-replay-sample.json (+ .manifest.json)
node capture-fixtures.mjs

# also refresh health/sessions/snapshot as *-live.json siblings (seeds untouched)
node capture-fixtures.mjs --all

# options
node capture-fixtures.mjs --host http://localhost:8000   # dashboard base URL
node capture-fixtures.mjs --max-events 60                 # cap the replay fixture
node capture-fixtures.mjs --token <bearer>                # if the server is auth-gated
```

Requires a dashboard running at `--host` (default `http://localhost:8000`). Exits
2 if unreachable, 3 if no session yields a non-empty replay.

### What it writes (into `../PiDashboardKit/Tests/PiDashboardKitTests/Fixtures/`)
| File | When | Consumed by |
|---|---|---|
| `event-replay-sample.json` | always | `ContractE2ETests` (decode + reduce the real replay) |
| `event-replay-sample.manifest.json` | always | provenance (sessionId, capturedAt, event-type histogram) |
| `health-live.json` / `sessions-live.json` / `ws-snapshot-live.json` | `--all` | refreshable siblings of the curated seeds |

The curated seed fixtures (`sessions-sample.json`, `health.json`,
`ws-snapshot-sample.json` — asserted with hardcoded counts) are **never**
overwritten; `--all` writes `*-live.json` siblings instead.

---

## 2. XCUITest e2e specs — `PiDashboardUITests/`

Real XCUITest code for flows **F1–F7** (TEST-CONTRACT §B), authored against the
§A accessibility identifiers. They drive the app in the hermetic **`-uitest`
fixture mode** (`DashboardStore` loads bundled fixtures — never touches a live
operator session).

| File | Flows |
|---|---|
| `PiDashboardUITestCase.swift` | shared base (launch, element lookup, composer-layout poll) |
| `ConnectAndListUITests.swift` | **F1** connect (+ unreachable-error), **F2** list/tier parity, **F3** open session |
| `ComposerUITests.swift` | **F4** single-row⇄multiline hysteresis + newline-forces-multiline, **F5** send gating |
| `BannerAndFiltersUITests.swift` | **F6** connection banner, **F7** search / folders / hide-stale filters |

### Integration wiring (SwiftPilot, at branch reconcile)

These specs live in `qa-e2e/` (test-CC owned) but the Xcode UITest target
(`PiDashboardUITests` in `ios/PiDashboard/project.yml`) currently sources from
`ios/PiDashboard/UITests/` (the build CC's smoke). To run the e2e suite, point
the UITest target at this directory **in addition to** the smoke. Either:

- **A — add a source path** to the `PiDashboardUITests` target in `project.yml`:
  ```yaml
  PiDashboardUITests:
    sources:
      - path: UITests           # the build CC's smoke
      - path: ../qa-e2e/PiDashboardUITests   # this suite
  ```
  then `xcodegen generate`; **or**

- **B — symlink/copy** `qa-e2e/PiDashboardUITests/*.swift` into
  `ios/PiDashboard/UITests/` before generating.

Option A keeps ownership clean (no file duplication across worktrees) and is
preferred.

### Run (after wiring + the app branch is integrated)

```bash
cd ios/PiDashboard
xcodegen generate          # regenerate PiDashboard.xcodeproj from project.yml

# pick a booted iOS 26.3 simulator (the regression floor device family)
xcrun simctl list devices available | grep iPhone

xcodebuild test \
  -project PiDashboard.xcodeproj \
  -scheme PiDashboard \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3' \
  -only-testing:PiDashboardUITests \
  2>&1 | tee /tmp/ios-uitest.log
```

Run a single flow:

```bash
xcodebuild test -project PiDashboard.xcodeproj -scheme PiDashboard \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3' \
  -only-testing:PiDashboardUITests/ComposerUITests/testF4_ComposerHysteresisSingleRowMultilineRevert
```

Screenshots captured by each flow are attached to the `.xcresult` bundle
(`XCTAttachment`, `.keepAlways`); open it in Xcode or extract with `xcparse`.

### Standalone type-check (no app target — what the test CC verifies pre-integration)

The specs reference only `XCTest` / `XCUIApplication` API (no app symbols), so they
type-check against the simulator SDK without the app:

```bash
cd ios/qa-e2e/PiDashboardUITests
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
FW="$(xcrun --sdk iphonesimulator --show-sdk-platform-path)/Developer/Library/Frameworks"
LIB="$(xcrun --sdk iphonesimulator --show-sdk-platform-path)/Developer/usr/lib"
xcrun swiftc -typecheck -sdk "$SDK" -target arm64-apple-ios17.0-simulator -F "$FW" -I "$LIB" *.swift
# exit 0, 0 errors, 0 warnings
```

### Pending build-session hook (F6 positive path)

`testF6_BannerAppearsWhenReconnecting` needs a small app affordance: honor a
`-uitest-reconnecting` launch argument that puts `DashboardStore` into the
`.reconnecting` phase on entry (XCUITest can't sever a hermetic fixture socket).
Until that lands, the test **SKIPS** with a coordination note (it does not fail).
The negative assertion (`testF6_NoBannerWhileConnected`) runs today. Reported to
SwiftPilot — see `ios/CC-TESTS-STATUS.md`.
