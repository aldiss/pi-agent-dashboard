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

Real XCUITest code for flows **F1–F7** (TEST-CONTRACT §B) + the app-layer
regression backfills, authored against the §A accessibility identifiers. They
drive the app in the hermetic **`-uitest` fixture mode** (`DashboardStore` loads
bundled fixtures — never touches a live operator session).

| File | Flows / backfill |
|---|---|
| `PiDashboardUITestCase.swift` | shared base — launch, `launchForcing(themeMode:hideEnded:)` (arg-domain UserDefaults forcing), `connectAndEnterList`, `openChat`, element lookup, composer-layout poll, `waitForAppear`/`waitForGone` |
| `ConnectAndListUITests.swift` | **F1** connect (+ unreachable-error), **F2** list/tier parity, **F3** open session |
| `ComposerUITests.swift` | **F4** single-row⇄multiline hysteresis + newline-forces-multiline, **F5** send gating |
| `BannerAndFiltersUITests.swift` | **F6** connection banner, **F7** search / folders / hide-stale filters |
| `ComposerThemeUITests.swift` | **Backfill #1** — composer interactable + text readable in light AND dark + live theme-switch (guards c7acd19 light-mode wash-out) |
| `StuckSendingUITests.swift` | **Backfill #2** — settled chat has nothing stuck at "Sending…" (hermetic guard); full send→reconcile skips pending a build hook (guards 9640dbb) |
| `SessionDeclutterUITests.swift` | **Backfill #3** — ended hidden by default + toggle reveals/re-hides; tenure-collapse +N skips pending a same-name fixture (guards e6cf8e3) |
| `ControlActionsUITests.swift` | **F-ext** — abort confirm-dialog, resume affordance, spawn sheet, message-type filter pills, settings round-trip |
| `ComposerFocusUITests.swift` | **Focus** — composer keeps draft + first-responder across the single-row⇄multiline flip and repeated re-layout; live-streaming + voice-append paths skip pending `-uitest-stream` / `-uitest-voice-append` |

**Regression suite (gap-fill).** One focused file per operator-visible area, driving
the §A identifiers hermetically. Each pairs a runs-today assertion with any
build-hook/fixture-gated path authored as a clean `XCTSkip` (see below).

| File | Area |
|---|---|
| `FoldingUITests.swift` | tier + directory fold via the header chevron; PWA default-collapsed set ({operator-chat-pane, other} collapsed); tier fold persists across relaunch. Forces both persisted fold sets empty via the arg domain for a clean-default start |
| `CrewCollapseUITests.swift` | crew canonical names remain visible across directories; same-directory tenures fold; `+N` badge reveals folded rows; distinct names → no spurious `+N` badge |
| `StatusRowUITests.swift` | status chip on its OWN row below the name (frame compare), single-line height-bounded, clear of the top-trailing `+N` zone |
| `ReadPositionUITests.swift` | DF#3 engagement-weighted unread negatives (no spurious divider / no asks-badge for a tool-prose chat); divider + restore-to-last-read skip pending a Tier-A + read-position fixture |
| `ModelPickerUITests.swift` | title opens the model picker; thinking-level grid renders + is tappable; Done dismisses; model-row select skips pending a models fixture |
| `SettingsThemeUITests.swift` | theme picker System/Dark/Light; live switch selects the segment; choice persists across relaunch (then restores System) |
| `CardRichnessUITests.swift` | context bar (with %) + git-branch badge render for a session with that data; tokens/cost/process-list/PR skip pending fixture data |
| `ColorCodingUITests.swift` | non-color signals backing the color language — rail-identity ternary (unread vs calm) + status a11y value/label; screenshots carry the color |
| `AccessibilityUITests.swift` | icon-button labels (settings/new-session/model/filter/mic), ≥40pt composer tap targets, non-color status word; send/attach label gap skips with a request |
| `ActionFailureUITests.swift` | Cluster-2 "never silent" negatives (no error/failure banner in steady state); failed resume/spawn + undeliverable send skip pending a failure-injection hook |

**Authored-but-skipping positive paths** (the F6-positive precedent — each needs a
small cc-ios-build affordance, so they SKIP cleanly rather than fail; the hermetic
guard beside each runs today):
- `StuckSendingUITests.testSendReconcilesOptimisticBubbleToConfirmed` — needs a
  `-uitest-echo-send` arg so `sendPrompt` produces the optimistic bubble +
  schedules the ack-net reconcile in fixture mode (`sendPrompt` no-ops under
  `-uitest` today, and the reconcile lives inside it).
- `SessionDeclutterUITests.testSameNameTenuresCollapseWithBadge` — needs a
  duplicate-canonical-name pair in one directory in `FixtureData.sessionsSnapshot()`
  so same-directory tenures fold + the `card-collapsed-count-*` badge renders.
- `ComposerFocusUITests` streaming/voice, `ReadPositionUITests` divider/restore,
  `ModelPickerUITests` model-select, `CardRichnessUITests` stats/process/PR,
  `AccessibilityUITests` send/attach labels, `ActionFailureUITests`
  resume/spawn/send failure — each skips pending the named launch-arg hook
  (`-uitest-stream` / `-uitest-voice-append` / `-uitest-action-error` /
  `-uitest-echo-send-fail`), fixture data (Tier-A asks + read position, a models
  list, token/cost/process/PR fields), or app label additions noted inline in the
  skip message.

### Regression coverage = core `swift test` + these XCUITests

Some shipped areas are covered by the CORE unit suite (`PiDashboardKit` `swift test`)
and are impractical / non-deterministic to drive end-to-end in the simulator — the
regression suite is the UNION of the two layers, not XCUITest alone:

| Area | Covered by (unit) | Why not E2E |
|---|---|---|
| WS-resilience / reconnect (DF#4) | `KeepaliveMonitor` / reconnect-backoff tests | XCUITest can't sever a hermetic fixture socket; the phase transitions are pure-logic |
| Data robustness (Cluster 6) | `DataRobustness` decode/malformed-payload tests | needs crafted malformed wire bytes fed to the decoder — no UI surface |
| Overflow + Dynamic Type (Cluster 4) | `TypeScale` / `dynamicTypeCap` tests | exhaustive size-class sweeps are a layout-math property, asserted pure |
| Light-contrast ratios (Cluster 3) | `Contrast` WCAG-ratio tests | a rendered-pixel contrast ratio isn't readable off an XCUIElement |
| Voice input | `VoiceInput` / `TranscriptAppender` tests | needs real AVAudioSession capture + the parakeet sidecar (unreachable in the sim) |

### Integration wiring (already live in `project.yml`)

The `PiDashboardUITests` target already sources this directory (Option A below),
so `xcodegen generate` picks up every spec here. No extra wiring needed:

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

# pick a booted iOS 26.3.1 simulator (the regression floor device family).
# destination-by-ID is the most robust (name+OS can drift across Xcode point
# releases — OS is 26.3.1, not 26.3); grab the id from:
xcrun simctl list devices available | grep iPhone

xcodebuild test \
  -project PiDashboard.xcodeproj \
  -scheme PiDashboard \
  -destination 'platform=iOS Simulator,id=D19C5CF4-BF12-471D-9896-4975F33C1825' \
  -only-testing:PiDashboardUITests \
  2>&1 | tee /tmp/ios-uitest.log
```

(Equivalent by name+OS if the id differs on your machine:
`-destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3.1'`.)

Run a single flow:

```bash
xcodebuild test -project PiDashboard.xcodeproj -scheme PiDashboard \
  -destination 'platform=iOS Simulator,id=D19C5CF4-BF12-471D-9896-4975F33C1825' \
  -only-testing:PiDashboardUITests/ComposerUITests/testF4_ComposerHysteresisSingleRowMultilineRevert
```

Run just the three backfill regression classes (composer light/dark, stuck-Sending,
declutter):

```bash
xcodebuild test -project PiDashboard.xcodeproj -scheme PiDashboard \
  -destination 'platform=iOS Simulator,id=D19C5CF4-BF12-471D-9896-4975F33C1825' \
  -only-testing:PiDashboardUITests/ComposerThemeUITests \
  -only-testing:PiDashboardUITests/StuckSendingUITests \
  -only-testing:PiDashboardUITests/SessionDeclutterUITests \
  2>&1 | tee /tmp/ios-backfill-test.log
```

### Compile-check without a sim run (box-safety — high host load)

A full `xcodebuild test` boots the sim + runs the suite (heavy). When the host is
under load, verify the specs COMPILE + link in the real Swift 6 target WITHOUT a
sim boot/run via `build-for-testing` (SwiftPilot owns the actual watched, calm-gated
test run):

```bash
cd ios/PiDashboard && xcodegen generate
xcodebuild build-for-testing -project PiDashboard.xcodeproj -scheme PiDashboard \
  -destination 'platform=iOS Simulator,id=D19C5CF4-BF12-471D-9896-4975F33C1825'
# ** TEST BUILD SUCCEEDED **  (compiles + links + signs the UITest bundle; no run)
```

Screenshots captured by each flow are attached to the `.xcresult` bundle
(`XCTAttachment`, `.keepAlways`); open it in Xcode or extract with `xcparse`.

### Standalone type-check (no app target — what the test CC verifies pre-integration)

The specs reference only `XCTest` / `XCUIApplication` API (no app symbols), so they
type-check against the simulator SDK without the app. **Critically, pass
`-swift-version 6 -strict-concurrency=complete`** — the app target sets
`SWIFT_VERSION 6.0`, and a plain typecheck (no flags) runs Swift 5 mode and will
MISS main-actor-isolation errors that the real target enforces (this exact gap let
a `@MainActor` regression through once):

```bash
cd ios/qa-e2e/PiDashboardUITests
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
FW="$(xcrun --sdk iphonesimulator --show-sdk-platform-path)/Developer/Library/Frameworks"
LIB="$(xcrun --sdk iphonesimulator --show-sdk-platform-path)/Developer/usr/lib"
xcrun swiftc -typecheck -swift-version 6 -strict-concurrency=complete \
  -sdk "$SDK" -target arm64-apple-ios17.0-simulator -F "$FW" -I "$LIB" *.swift
# exit 0, 0 errors, 0 warnings
```

This still isn't a substitute for the real `xcodebuild test` above (only the target
build exercises the full UITest-runner link + run) — but it now catches the same
class of strict-concurrency errors pre-integration.

### Pending build-session hook (F6 positive path)

`testF6_BannerAppearsWhenReconnecting` needs a small app affordance: honor a
`-uitest-reconnecting` launch argument that puts `DashboardStore` into the
`.reconnecting` phase on entry (XCUITest can't sever a hermetic fixture socket).
Until that lands, the test **SKIPS** with a coordination note (it does not fail).
The negative assertion (`testF6_NoBannerWhileConnected`) runs today. Reported to
SwiftPilot — see `ios/CC-TESTS-STATUS.md`.
