# CC-BUILD-STATUS — native iPhone pi-dashboard (cc-ios-build session)

Branch `feat/native-ios-app`. Supervised by SwiftPilot. Honest running log — every
"done" backed by real command output. Simulator only (no device signing), no OAuth.

## Acceptance gates (brief §5) — ALL PASS
| # | Gate | Status | Evidence (real output) |
|---|---|---|---|
| 1 | `swift test` floor green | ✅ | `Executed 51 tests, with 0 failures` (27 seed + 16 EventReducer + 8 DirectoryGrouping) |
| 2 | `xcodegen generate` clean | ✅ | `Created project at …/PiDashboard.xcodeproj` |
| 3 | Boot iPhone sim on iOS 26.3 | ✅ | `iPhone 17 Pro (D19C5CF4-…) (Booted)` |
| 4 | `xcodebuild … build` | ✅ | `** BUILD SUCCEEDED **` (iPhone 17 Pro, iOS 26.3 sim) |
| 5 | Launch → ConnectView no crash | ✅ | installed + launched (pid), screenshot verified (ios/screenshots/connect.png) |
| 6 | XCUITest smoke + screenshots | ✅ | `Test Case … testSmokeConnectListChatComposerHysteresis passed` · 4 screenshots in ios/screenshots/ |
| 7 | Unit tests for new core logic green | ✅ | EventReducer (16) + DirectoryGrouping (8) all green |

## Toolchain (verified)
- xcodegen 2.44.1 · Swift 6.2.3 · Xcode at `/Applications/Xcode.app` · iOS 26.3 runtime
- Target sim: **iPhone 17 Pro** (`D19C5CF4-BF12-471D-9896-4975F33C1825`)

## Ownership ledger — FILE BY FILE (brief §0a, Joan amendment)
Adoption classes: **(1) driver-seeded, CC-retained-as-is** (actively reviewed +
critiqued, kept because correct), **(2) driver-seeded, CC-reworked** (changed —
what + why noted), **(3) CC-authored** (new this session). Active adoption: every
seed core file was read and critiqued; reworks applied where warranted.

### PiDashboardKit/Sources (the owned core)
| File | Author | Adoption | Critique → action |
|---|---|---|---|
| `Models/Session.swift` | driver seed | **(2) reworked** | Faithful to TS. **Reworked**: `displayName` firstMessage fallback now uses FIRST line only (multi-line prompt made a broken card title; search still matches full text). Added public init to `DriverProgress`/`DriverNextEngagement`/`Worktree` (public structs were uninitializable from app/test modules — real API gap). |
| `Models/SessionPatch.swift` | driver seed | **(1) retained** | `apply(to:)` partial-merge semantics correct + complete vs `Partial<DashboardSession>`. No change warranted. |
| `Models/Event.swift` | driver seed | **(1) retained** | `DashboardEvent{eventType,timestamp,data}` + `SequencedEvent` exact. Consumed by EventReducer. No change. |
| `Models/Health.swift` | driver seed | **(2) reworked** | **Reworked**: added public inits to `HealthStatus` + `ServerMetrics` (fixture/app construction needs them; synthesized inits were internal). |
| `Models/Misc.swift` | driver seed | **(1) retained** | `ModelInfo`/`ImageContent`/`DynamicKey` correct; `ImageContent` already has public init. No change. |
| `Models/JSONValue.swift` | driver seed | **(1) retained** | Type-erased JSON decode order (null→bool→number→string→object→array) correct for `JSONDecoder`. Accessors sufficient for the reducer. No change. |
| `Protocol/Messages.swift` | driver seed | **(1) retained** | `ServerMessage` decode + `ClientMessage` encode verified vs `browser-protocol.ts`; unknown→`.unknown` forward-compat. Round-trip tests green. No change. |
| `Net/DashboardClient.swift` | driver seed | **(2) reworked** | **Reworked** (real concurrency bug): seed flipped `state=.connected` synchronously and the receive loop mutated `continuation`/`state` without checking it still owned the socket — a superseded loop post-reconnect could `finish()` the live stream. Bound socket into `receiveLoop(socket:)`, identity-gate every shared write on `socket===task`, flip `.connected` on first frame. Enables clean reconnect/banner. |
| `Sessions/SessionGrouping.swift` | driver seed | **(2) reworked** | Seed tier grouping (`classifyTier`/`groupByTier`/filters/sort/rank) correct → retained. **Added** secondary directory grouping (`DirectoryGroup`, `groupPath`, `groupByDirectory`, `groupTierByFolder`) — required by SessionListView, absent from seed. **Fixed** empty-pinned-group leak (pinned dir rendered as empty folder in every tier). |
| `Chat/ComposerLayout.swift` | driver seed | **(1) retained** | Hysteresis rule + clamp + canSend exact match to `MobileComposer.tsx` @ dda5919. The app's composer drives THIS, not a reimplementation. No change. |
| `Chat/EventReducer.swift` | **CC** | **(3) authored** | New. Port of `event-reducer.ts` MVP subset: user/assistant text, thinking, tool call+result lifecycle, turn stats, subagents, bash, command-feedback upsert, raw fallback. Preserves streaming-text-flush-before-tool ordering. |
| `Theme/Tokens.swift` | driver seed | **(2) reworked** | **Reworked**: lifted exact `--text-*` hex from `index.css :root` (#e5e5e5/#b0b0b0/#808080, were provisional). bg/border/accent confirmed already-correct. |

### PiDashboard (the app target — all CC-authored, class 3)
| File | Purpose |
|---|---|
| `Sources/PiDashboardApp.swift` | `@main` + RootView (Connect↔Main switch, stays mounted across drops) |
| `Sources/Theme.swift` | `Color(hex:)` + `Theme` mapping `DashboardTheme.dark` → SwiftUI Color; env injection |
| `Sources/DashboardStore.swift` | `@MainActor @Observable` store: WS stream consume, registry/orders/pinned, event routing → ChatSessionState, reconnect/backoff, guarded compose, `-uitest` fixture path |
| `Sources/ConnectView.swift` | Server URL + token + health probe + known-servers (UserDefaults) |
| `Sources/KnownServers.swift` | `KnownServer` + UserDefaults persistence |
| `Sources/MainView.swift` | NavigationStack + ConnectionBanner |
| `Sources/SessionListView.swift` | Search + toggles + tier sections + directory subgroups |
| `Sources/SessionCard.swift` | StatusChip + ContextBar + model + git + unread + driver progress + next-engagement + relative time |
| `Sources/Format.swift` | Relative-age / context-% / model-label / engagement-label formatters |
| `Sources/ChatView.swift` | subscribe + session_view/unview lifecycle, scrollback, send-failure banner |
| `Sources/ChatMessageRow.swift` | Per-role renderers (user/assistant/thinking/tool/bash/cmd/raw) + markdown |
| `Sources/AdaptiveComposer.swift` | MobileComposer port: ComposerLayout-driven single-row⇄column, send/stop/attach, queue badge, haptics |
| `Sources/GrowingTextView.swift` | UITextView bridge: auto-size + height report, Enter=newline |
| `Sources/FixtureData.swift` | Hermetic `-uitest` fixtures (snapshot + reduced chat) |
| `UITests/PiDashboardSmokeUITests.swift` | Minimal smoke (build CC owns minimal; comprehensive suite = cc-ios-tests) |
| `project.yml` | XcodeGen spec (iOS 17, app "pi dashboard", PiDashboardKit dep) |

### Driver-authored SPEC/SCAFFOLD (not CC-owned; kept, labeled)
| File | Owner | Role |
|---|---|---|
| `ios/DESIGN.md` | SwiftPilot | Design spec — unchanged |
| `…/TEST-CONTRACT.md` | SwiftPilot | §A identifiers set on my components |
| `Tests/.../*` (seed: Grouping/Composer/Protocol/SessionDecoding + Fixtures) | SwiftPilot | Regression floor — kept green, not weakened |
| `Tests/.../EventReducerTests.swift`, `DirectoryGroupingTests.swift` | **CC** | Co-located coverage for owned logic |

## Parity notes (vs PWA mobile shell)
- ConnectView, list (tier + directory subgroups, pinned-first), SessionCard richness,
  chat row kinds, composer single-row⇄column hysteresis, dark palette — all verified
  by rendered screenshots (ios/screenshots/), not self-report.
- Composer hysteresis uses the core `ComposerLayout` (same rule the unit tests pin).

## Deferred (operator decision, per brief)
- Physical-device signing, OAuth login surface, voice/terminals/editor/flows — out of
  MVP. Protocol layer leaves room.

## Commits (this session, on feat/native-ios-app)
1. `feat(ios): own core — EventReducer port, reconnect-safe client, directory grouping`
2. `feat(ios): SwiftUI app target — connect/list/chat/composer on PiDashboardKit`
3. `test(ios): passing XCUITest smoke + parity screenshots; fix tier a11y + empty pins`
