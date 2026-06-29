# CC-BUILD-STATUS — native iPhone pi-dashboard (cc-ios-build session)

Branch `feat/native-ios-app`. Supervised by SwiftPilot. Honest running log — every
"done" backed by real command output. Simulator only (no device signing), no OAuth.

## Acceptance gates (brief §5)
| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | `swift test` floor green | ✅ | 50/50 (27 seed + 16 EventReducer + 7 DirectoryGrouping) |
| 2 | `xcodegen generate` clean | ⏳ | scaffolding |
| 3 | Boot iPhone sim on iOS 26.3 | ✅ | iPhone 17 Pro `D19C5CF4-…` Booted |
| 4 | `xcodebuild … build` BUILD SUCCEEDED | ⏳ | pending app target |
| 5 | Launch → ConnectView no crash | ⏳ | pending |
| 6 | XCUITest smoke + screenshots | ⏳ | pending |
| 7 | Unit tests for new core logic green | ✅ | EventReducer (16) + DirectoryGrouping (7) |

## Toolchain (verified)
- xcodegen 2.44.1 · Swift 6.2.3 · Xcode at `/Applications/Xcode.app` · iOS 26.3 runtime
- Target sim: **iPhone 17 Pro** (`D19C5CF4-BF12-471D-9896-4975F33C1825`), booted

## Ownership ledger (brief §0a — required)
Distinguishes what cc-ios-build authored/owns from driver-authored spec/scaffold.
The deliverable is NOT a veneer: the core was read, critiqued, and reworked.

| Area | Path | Owner | Notes |
|---|---|---|---|
| Models | `Sources/.../Models/*` | **cc-ios-build** (adopted) | Read + critiqued seed; correct & faithful to TS contract → adopted as-is. Owned. |
| Protocol | `Sources/.../Protocol/Messages.swift` | **cc-ios-build** (adopted) | Encode/decode verified vs `browser-protocol.ts`; adopted as-is. Owned. |
| Net | `Sources/.../Net/DashboardClient.swift` | **cc-ios-build** (reworked) | **Reworked**: fixed reconnect concurrency bug (old receive-loop could finish the new stream); socket-identity-gated all shared-state writes; stream finishes on drop to drive banner/backoff. |
| Sessions | `Sources/.../Sessions/SessionGrouping.swift` | **cc-ios-build** (extended) | Seed tier grouping adopted; **added** secondary directory grouping (`DirectoryGroup`, `groupByDirectory`, `groupTierByFolder`, `groupPath`) — required by SessionListView, absent from seed. |
| Chat (composer) | `Sources/.../Chat/ComposerLayout.swift` | **cc-ios-build** (adopted) | Hysteresis rule correct & matches `MobileComposer.tsx`; adopted as-is. Owned. |
| Chat (reducer) | `Sources/.../Chat/EventReducer.swift` | **cc-ios-build** (authored) | **New file** — full port of `event-reducer.ts` MVP subset (text/thinking/tool/stats/subagents/bash/raw + flush-before-tool ordering). |
| Theme | `Sources/.../Theme/Tokens.swift` | **cc-ios-build** (reworked) | Lifted exact `--text-*` hex from `index.css :root` (#e5e5e5/#b0b0b0/#808080, was provisional). |
| App target | `ios/PiDashboard/**` | **cc-ios-build** (authored) | SwiftUI app — in progress. |
| — | | | |
| Design spec | `ios/DESIGN.md` | driver (SwiftPilot) | Spec — unchanged. |
| Test contract | `…/TEST-CONTRACT.md` | driver (SwiftPilot) | §A identifiers set on my components. |
| Seed tests/fixtures | `Tests/**` (seed files) | driver (SwiftPilot) | Regression floor — kept green, not weakened. |
| New core tests | `Tests/.../EventReducerTests.swift`, `DirectoryGroupingTests.swift` | **cc-ios-build** | Co-located coverage for owned logic. Comprehensive suite → cc-ios-tests. |

## Core reworks (ownership detail)
1. **DashboardClient reconnect safety** — the seed flipped `state=.connected`
   synchronously and the receive loop mutated `continuation`/`state` without
   checking it still owned the socket. After a reconnect, a superseded loop tearing
   down could `finish()` the live stream. Rework binds the socket into
   `receiveLoop(socket:)` and gates every shared write on `socket === task`; state
   flips to `.connected` only when the first frame actually arrives.
2. **Directory grouping** — ported `groupSessionsByDirectory` / `groupTierByFolder`
   semantics (pinned-first in pin order incl. empties, worktree→`groupCwd` fold,
   server-order within group). POSIX path folding (operator host is macOS).
3. **EventReducer** — owned chat state fold; preserves the load-bearing
   streaming-text-flush-before-tool ordering so `[text, toolCall]` renders in order.

## Log
- Read DESIGN.md + all of `Sources/**` + seed tests + PWA refs (event-reducer,
  MobileComposer, session-grouping, index.css). Floor: 27/27 green at entry.
- Authored EventReducer (+16 tests) → 43/43. Reworked DashboardClient + added
  directory grouping (+7 tests) → 50/50. Refined theme text hex.
- Next: scaffold `ios/PiDashboard` app target via XcodeGen with §A identifiers.
