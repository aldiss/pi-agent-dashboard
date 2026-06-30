# HANDOFF — Native iPhone pi-dashboard app (night 1)

Driver: **SwiftPilot** (PI). Supervised two Claude Code build sessions; verified everything own-hand.
Date: 2026-06-30. Base: `dda5919`. Integration branch: **`feat/native-ios-tests`** (the superset — app +
core + full test suite + e2e). Sister branch `feat/native-ios-app` carries the app+core subset.

## 1. What was delivered (all independently re-verified by the driver)

A **real native iPhone app** in Swift/SwiftUI (NOT a PWA, NOT a WebView) that speaks the dashboard's
actual browser-protocol + REST contract, with the dashboard's UX as the North Star.

| Deliverable | Status | Driver-verified evidence |
|---|---|---|
| SwiftUI app builds for iOS sim | ✅ | `xcodebuild ... build` → `** BUILD SUCCEEDED **` (own-hand) |
| Core contract/unit/property tests | ✅ | `swift test` → **108 passed, 0 failures** (own-hand; grounded in REAL captured `/api/sessions`, `/api/health`, WS `sessions_snapshot`, 68-event `event_replay`) |
| XCUITest e2e F1–F7 on the sim | ✅ | `xcodebuild test -only-testing:PiDashboardUITests` → `** TEST SUCCEEDED **`, 13 tests, 12 passed + 1 skipped, 0 failures (own-hand, iPhone 17 Pro / iOS 26.3.1) |
| Read-only fixture-capture harness | ✅ | code-audited: `SAFE_CLIENT_TYPES` allowlist throws before the socket; only `subscribe`/`unsubscribe`; no mutation path |
| Parity checklist | ✅ | `ios/PARITY.md` — PWA↔native↔test-id↔status, F1–F7 rows ✅ |

**MVP surfaces working:** configurable server connect (URL + optional bearer token) · session list with the
dashboard's real tier grouping (standing-crew→drivers→cell-executor→operator-chat-pane→worker→other) +
directory subgroups + status chips + context bars + filters (search/folders/hide-stale) · session detail/chat
(event-reducer rendering) · the **adaptive single-row⇄multiline composer** with the exact hysteresis
(45/20, no flip-flop) + send/queue-while-streaming/stop + photo attach · connection banner.

## 2. Ownership split (per operator directive: CC builds, driver supervises)

- **`cc-ios-build` (CC) — owns the app implementation:** all of `ios/PiDashboard/**` (SwiftUI app, store,
  views, composer) + `ios/PiDashboardKit/Sources/**` (took ownership of the driver seed: reviewed,
  critiqued, **reworked** — incl. fixing a real reconnect-concurrency bug in `DashboardClient` — and
  authored `EventReducer` + directory grouping). File-by-file ownership ledger in `ios/CC-BUILD-STATUS.md`.
- **`cc-ios-tests` (CC) — owns the durable test suite:** `ios/PiDashboardKit/Tests/**` (108 tests) +
  `ios/qa-e2e/**` (read-only harness + XCUITest e2e F1–F7) + `ios/PARITY.md` + `ios/CC-TESTS-STATUS.md`.
- **SwiftPilot (driver) — design/spec + integration + verification only:** `ios/DESIGN.md`,
  `TEST-CONTRACT.md`, the CC briefs, the project.yml qa-e2e wiring (reconcile glue), this `HANDOFF.md`. Did
  NOT author product code; re-ran every build/test to verify.
- **No AI attribution** in any commit (author = operator git identity). Each session worked in an isolated
  git worktree; the operator's main checkout + dirty files were never touched.

## 3. Deferred (explicit, with rationale)

| Item | Why deferred | To close |
|---|---|---|
| **Physical-device install** | Needs the operator's Apple Developer Team ID / signing identity in Xcode — can't self-provision | Open the project in Xcode, set the Team, run on a paired iPhone |
| **OAuth2 / JWT login** | MVP scoped to URL + optional bearer token (operator decision) | Phase 2 — add the dashboard's OAuth web-login surface |
| **F6-positive XCUITest** (`testF6_BannerAppearsWhenReconnecting`) | Needs a small app hook: `DashboardStore` should enter `.reconnecting` under a `-uitest-reconnecting` launch arg (XCUITest can't sever a hermetic fixture socket). App-target change = `cc-ios-build`-owned. Currently SKIPS cleanly (does not fail) | cc-ios-build adds the launch-arg branch in `DashboardStore`; the spec is already authored |
| **Chat fixture coverage** | The `-uitest` chat fixture seeds only the first session, so opening another shows "Loading session…" above a working composer — fixture-coverage detail, not an app bug | extend the bundled fixture to seed more sessions |
| **iPad / macOS apps** | Later nights (operator intent) | reuse `PiDashboardKit` (shared core) + new SwiftUI shells |

## 4. Exact build / test / run commands

```bash
cd /Users/vdrobkov/Misc/Documents/Copilot/pi-agent-dashboard-ios-tests   # the integration worktree

# core contract/unit/property suite (no simulator) — 108 green
cd ios/PiDashboardKit && swift test

# build the app for the simulator
cd ../PiDashboard && xcodegen generate
xcodebuild -project PiDashboard.xcodeproj -scheme PiDashboard \
  -destination 'generic/platform=iOS Simulator' build

# run the XCUITest e2e (F1–F7) on a booted iOS 26.3.1 iPhone sim
xcodebuild test -project PiDashboard.xcodeproj -scheme PiDashboard \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3.1' \
  -only-testing:PiDashboardUITests

# refresh the real event_replay fixture (read-only; needs a dashboard up)
cd ../qa-e2e && node capture-fixtures.mjs
```

Screenshots from the build pass: `ios/screenshots/{connect,list,chat-composer-single-row,chat-composer-multiline}.png`.
Status docs: `ios/CC-BUILD-STATUS.md` (app + ownership ledger), `ios/CC-TESTS-STATUS.md` (test suite + ledger),
`ios/PARITY.md` (parity table), `ios/DESIGN.md` (design pass), `qa-e2e/README.md` (e2e run + wiring).

## 5. Supervision record

Driver ran, own-hand: `xcodebuild build` (BUILD SUCCEEDED), `swift test` (108) at every milestone, and the
full `xcodebuild test` e2e (TEST SUCCEEDED, 13 tests). Caught + routed a real in-target Swift 6
strict-concurrency compile failure that the test session's standalone `swiftc -typecheck` missed
(`@MainActor` isolation) — fixed by the owner, re-verified by the driver. Author≠verifier across two
distinct CC sessions held throughout; boundary discipline (each session touched only its own files) +
read-only-against-live-sessions safety rail both verified.
