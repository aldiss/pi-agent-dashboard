# PARITY — native iPhone pi-dashboard ≙ PWA

Living proof-of-parity for the native iPhone app vs the pi-dashboard PWA (the
North Star). Each row: **PWA behavior ↔ native behavior ↔ test id ↔ status**.
Seeded from `ios/DESIGN.md` §3 (surfaces) + §4 (composer) and
`TEST-CONTRACT.md` §B (e2e flows) / §D (parity).

Owned by **cc-ios-tests**. This is also the template for the iPad / macOS passes
(the `PiDashboardKit` core is shared substrate — every ✅ logic row carries over).

## Legend
- ✅ **verified** — parity proven by a test that is **green today**: either
  `cd ios/PiDashboardKit && swift test` (565, no simulator) OR an `e2e:Fn`
  XCUITest that RUNS GREEN in the integrated `PiDashboardUITests` target
  (`xcodebuild test` on the iOS 26.3.1 simulator).
- 🟡 **partial** — one layer green, another pending: typically the core logic is
  ✅ via `swift test` while the UI render is not independently e2e-asserted, or a
  positive path needs a small build-CC app hook (F6-reconnect).
- ⛔ **deferred** — out of MVP scope (`DESIGN.md` §7); not yet built/tested.

Test-id key: `swift:SuiteName` = green CLI test; `harness:mode` = real-store
WebSocket harness; `e2e:Fn` = XCUITest flow (`qa-e2e/PiDashboardUITests/`).

---

## 1. Connect screen (DESIGN §3.1)

| PWA behavior | Native behavior | Test id | Status |
|---|---|---|---|
| Server URL configurable, default `http://localhost:8000` | `ConnectView` `connect-server-url` prefilled with the default | `e2e:F1` (`testF1_ConnectEntersSessionList`) | ✅ |
| Health probe (`/api/health`) verifies a live dashboard | `RestClient.health()` decodes `HealthStatus` from real bytes | `swift:SessionDecodingTests` (`testDecodeHealth`) | ✅ |
| `http(s)` base → `ws(s)` browser-gateway URL | `DashboardClient.websocketURL` scheme/path mapping | `swift:ProtocolRoundTripTests` (`testWebsocketURLMappingMatrix`) | ✅ |
| Unreachable / non-dashboard URL → error state | `connect-error` banner on failed connect | `e2e:F1` (`testF1_UnreachableServerShowsError`) | ✅ |
| Per-origin credential; foreign, expired, or remote-HTTP credential omitted without blocking connect | `CredentialOrigin` + `CredentialPolicy`; isolated REST/WS/voice cookie jars | `swift:CredentialOriginTests`, `swift:CredentialPolicyTests`; `harness:cross-origin` | ✅ |
| OAuth cancellation/exchange/session failures stay visible | `AuthManager.lastError` → `connect-error` | `e2e:ConnectErrorUITests.testExchangeFailureShowsError` | ✅ |
| Optional bearer token | `connect-token` field → `Authorization: Bearer` header | `swift` (RestClient/DashboardClient header path) | 🟡 |
| Persist known servers | `KnownServersStore` + `known-server-row-<host>` | — (build-CC owned) | 🟡 |
| `/api/sessions` initial load (env-wrapped or bare) | `RestClient.sessions()` handles both shapes | `swift:PatchAndModelContractTests` (`testApiResponseEnvelope`), `swift:SessionDecodingTests` | ✅ |

## 2. Session list — grouping / filters / card (DESIGN §3.2)

| PWA behavior | Native behavior | Test id | Status |
|---|---|---|---|
| PRIMARY tier grouping (`classifyTier`): standing-crew→drivers→cell-executor→operator-chat-pane→worker→other | `SessionGrouping.classifyTier` + `groupByTier` (canonical order, partition) | `swift:GroupingTests`, `swift:GroupingPropertyTests` (`testGroupByTierIsAPartition`, `…PermutationInvariant`) | ✅ |
| SECONDARY directory grouping, pinned dirs first, `groupCwd` worktree fold | `SessionGrouping.groupByDirectory` / `groupTierByFolder` | `swift:DirectoryGroupingTests`, `swift:GroupingPropertyTests` (`testGroupByDirectoryPartitionsAndFoldsWorktrees`, `testPinnedDirsComeFirstInPinOrder`) | ✅ |
| At least one tier section renders; cards show name + status | `tier-section-<tier>`, `session-card-name`, `session-card-status` | `e2e:F2` (`testF2_ListShowsTiersAndCardFields`) | ✅ |
| Display name: name → firstMessage → cwd basename | `DashboardSession.displayName` (first line of firstMessage) | `swift:PatchAndModelContractTests` (`testDisplayNameFallbackChain`) | ✅ |
| Status chip color (active→green / streaming→blue / idle→muted / ended→faint) | `DashboardTheme.statusColor` + `session-card-status` value | `swift:ComposerModelPropertyTests` (`testStatusColorMapping`) | ✅ |
| Context-% bar (`contextTokens/contextWindow`) | `DashboardSession.contextFraction` (clamped 0…1) + `session-card-context-bar` | `swift:PatchAndModelContractTests` (`testContextFractionMath`) | ✅ |
| Model + thinking label | `session-card-model` (Format.modelLabel) | `swift:ComposerModelPropertyTests` (`testModelInfoQualifiedForm`) | ✅ |
| Unread stripe (only when unread) | `session-card-unread` (present iff `unread==true`) | — (card render; fixture has unread) | 🟡 |
| Driver progress + next-engagement badge | `DriverProgress` / `DriverNextEngagement` decode + card row | `swift:PatchAndModelContractTests` (`testDecodeFullSessionRoundTrip`) | ✅ |
| Search filter (name → firstMessage → cwd basename) | `list-search` → `filterByQuery` | `swift:GroupingPropertyTests` (`testFilterByQueryIsSubsetAndIdempotent`); `e2e:F7` (`testF7_SearchNarrowsCards`) | ✅ |
| Folders on/off (flatten directory subgroups) | `toggle-folders` → `groupTierByFolder folders:false` | `swift:DirectoryGroupingTests` (`testGroupTierByFolder_offFlattens`); `e2e:F7` (`testF7_FoldersToggleFlattensDirectoryGroups`) | ✅ |
| Hide-stale (threshold hrs) drops stale-active | `toggle-hide-stale` → `filterStale` | `swift:GroupingTests`, `swift:GroupingPropertyTests` (`testFilterStaleMonotoneInThreshold`); `e2e:F7` (`testF7_HideStaleToggleFlipsState`) | ✅ |
| Show-hidden | `toggle-show-hidden` → `filterSessions showHidden` | `swift:GroupingPropertyTests` (`testFilterSessionsActiveOnlyAndHidden`) | ✅ |
| Server-order sort, alive-first rank | `sortSessionsByOrder`, `rankActiveFirst` | `swift:GroupingPropertyTests` (`testSortByOrderIsPermutation…`, `testRankActiveFirstIsStablePartition`) | ✅ |

## 3. Connection lifecycle / live deltas (DESIGN §2)

| PWA behavior | Native behavior | Test id | Status |
|---|---|---|---|
| On connect, `sessions_snapshot` REPLACES the registry (drops stale ids) | `DashboardStore.apply(.sessionsSnapshot)` replace; decode via `ServerMessage` | `swift:SessionDecodingTests` (`testDecodeRealWebSocketSnapshot`), `swift:ProtocolRoundTripTests` (`testSnapshotDefaultsMissingArraysAndMaps`) | ✅ |
| `session_added` / `session_removed` / `sessions_reordered` / `pinned_dirs_updated` | `ServerMessage` decode + store apply | `swift:ProtocolRoundTripTests` (`testDecodeSessionAdded…`, `…Removed`, `…Reordered`, `…PinnedDirsUpdated`) | ✅ |
| `session_updated {updates: Partial<DashboardSession>}` merges onto existing | `SessionPatch.apply(to:)` (present fields only; absent untouched) | `swift:PatchAndModelContractTests` (`testPatchMergesPresentFieldsOnly`, `testPatchAppliesEverySupportedField`, `testSequentialPatchesAccumulate`) | ✅ |
| `subscribe {sessionId,lastSeq?}` → batched `event_replay` then live `event` | `ClientMessage.subscribe` encode; `ServerMessage.eventReplay`/`event` decode | `swift:ProtocolRoundTripTests` (`testEncodeSubscribe…`, `testEventReplayDefaultsIsLast…`, `testDecodeLiveEventFrame`) | ✅ |
| Forward-compat: unknown server message types don't break the client | `ServerMessage.unknown(type:)` | `swift:ProtocolRoundTripTests` (`testUnknownTypePreservesWireType`); unknown enum → raw string (`testUnknownStatusStaysRawString`) | ✅ |
| Reconnect/backoff on socket drop | `DashboardStore.scheduleReconnect` (exp backoff, cap 30s) | `harness:close`, `harness:stall` | ✅ |
| Rejected WS credential stops backoff and clears only target origin | typed 401 + `/auth/status` discriminator → `.authRequired(origin:)` | `harness:auth-reject` | ✅ |
| **Real session replay decodes + reduces faithfully** | full `ServerMessage`→`ChatSessionState` on a REAL captured 68-event replay | `swift:ContractE2ETests` (all 6) | ✅ |

## 4. Session detail / chat (DESIGN §3.3)

| PWA behavior | Native behavior | Test id | Status |
|---|---|---|---|
| Open session → chat surface + composer mount; app sends `session_view` | tap `session-card-<id>` → `chat-scroll` + `mobile-composer`; `openSession` → `session_view` | `e2e:F3` (`testF3_OpenSessionShowsChatAndComposer`); wire msg `swift:ProtocolRoundTripTests` (`testEncodeEverySingleSessionIdMessage`) | ✅ |
| Reduced event stream: user / assistant / thinking / tool call+result / turn-end / bash / subagents | `ChatSessionState.reduce` per event type | `swift:EventReducerTests` (seed, 16); behavioral on real data `swift:ContractE2ETests` | ✅ |
| Streaming-text flush ordering (text row before tool row) | reducer flush keyed on `toolCallId` (replay-idempotent) | `swift:EventReducerTests` (`testStreamingTextFlushedBeforeToolRow`); `swift:ContractE2ETests` (`testToolRowsIdempotentAcrossReplayedBatch`) | ✅ |
| Scrollback + live append; stable row identity | unique non-empty row ids (SwiftUI ForEach invariant) | `swift:ContractE2ETests` (`testRealEventReplayReducesToCoherentState`) | ✅ |
| Markdown rendering | `ChatMessageRow` (build-CC owned) | — | 🟡 |

## 5. Adaptive composer (DESIGN §4 — the North Star)

| PWA behavior | Native behavior | Test id | Status |
|---|---|---|---|
| Single-row ⇄ column over ONE stable view tree | `AdaptiveComposer` two layouts, `mobile-composer-card` value `single-row`/`multiline` | `e2e:F4` (`testF4_ComposerHysteresisSingleRowMultilineRevert`) | ✅ |
| Flip rule with hysteresis (constants 45/20, no flip-flop pocket) | `ComposerLayout.isMultiline` (entry: h>45 ∧ len>20; stay: len>20) | `swift:ComposerLayoutTests` (seed); `swift:ComposerModelPropertyTests` (`testEntryRuleRequiresBothHeightAndLength`, `testStayRuleIsLengthOnly`, `testNoFlipFlopAcrossSingleCharEdits`, `testSharedFloorHasNoOscillationPocket`) | ✅ |
| `hasNewline ? true` — newline always multiline | `ComposerLayout.isMultiline` newline clause | `swift:ComposerModelPropertyTests` (`testNewlineForcesMultilineUniversally`); `e2e:F4` (`testF4_NewlineForcesMultilineAndNeverSends`) | ✅ |
| Enter inserts newline, NEVER sends (mobile) | `GrowingTextView` returnKey=default | `e2e:F4` (`testF4_NewlineForcesMultilineAndNeverSends`) | ✅ |
| Height clamp: empty→36, else [36,200] | `ComposerLayout.clampedHeight` | `swift:ComposerLayoutTests`, `swift:ComposerModelPropertyTests` (`testClampedHeightProperties`) | ✅ |
| Send enabled iff trimmed-nonempty OR ≥1 image (not gated on streaming) | `ComposerLayout.canSend` + `mobile-composer-send` enabled state | `swift:ComposerModelPropertyTests` (`testCanSendTruthTable`); `e2e:F5` (`testF5_SendButtonGating`) | ✅ |
| Tap-to-queue while streaming → `N queued` badge | `mobile-composer-queue-badge` (queuedCount>0) | — (badge render; queue path build-CC) | ⛔ (MVP stub: queuedCount=0) |
| Stop button additive (red) while working | `mobile-composer-stop` (present iff streaming) | — | 🟡 |
| Image attach (PhotosUI) jpeg/png/gif/webp → base64 | `mobile-composer-attach`; `ImageContent {type:"image",data,mimeType}` | `swift:PatchAndModelContractTests` (`testImageContentTypeDiscriminator`), `swift:ProtocolRoundTripTests` (`testEncodeSendPromptFieldMatrix`) | ✅ encode / 🟡 picker |
| Haptics on send/stop | `UINotificationFeedbackGenerator` | — (device-only) | ⛔ |

## 6. Status / health (DESIGN §3.5)

| PWA behavior | Native behavior | Test id | Status |
|---|---|---|---|
| Connection banner on >3s disconnect | `connection-banner` (shown while `.reconnecting`/`.failed`) | `e2e:F6` (`testF6_NoBannerWhileConnected` ✅ green; `testF6_BannerAppearsWhenReconnecting` SKIPS pending the build-CC `-uitest-reconnecting` hook) | ✅ neg / 🟡 pos |
| Auth rejection offers sign-in inside dashboard | `.authRequired` banner + `auth-required-signin` | `e2e:AuthRequiredUITests.testAuthRequiredBannerOffersSignIn` | ✅ |
| Bridge-absent send failure surfaced | `send_prompt_failed` → `sendFailures` banner | `swift:ProtocolRoundTripTests` (`testSendPromptFailedOptionalFields`) | ✅ decode / 🟡 UI |
| Server restarting / spawn errors safe states | — | — | ⛔ |

## 7. Theme (DESIGN §5)

| PWA behavior | Native behavior | Test id | Status |
|---|---|---|---|
| Dark default palette (operator's `:root` hexes) | `DashboardTheme.dark` tokens | `swift:ComposerModelPropertyTests` (`testDarkPaletteCoreTokens`) | ✅ |
| Light + warm-paper themes swappable | `ThemePalette` (swappable) | — | ⛔ (tokens present; light/warm not lifted) |

## 8. Deferred (DESIGN §7) — explicitly out of MVP

| Surface | Status |
|---|---|
| Physical-device install (signing/Team ID) | ⛔ |
| Physical OAuth/Keychain acceptance (#20–22) | ⛔ UNRUN |
| Voice push-to-talk, terminals, editor proxy, package mgmt, flow/architect panels | ⛔ |
| iPad / macOS passes (shared core ready) | ⛔ (this doc is the template) |

---

## Summary

| Layer | Verified now (✅) | Partial (🟡) | Deferred (⛔) |
|---|---|---|---|
| Contract / protocol / models | 565 `swift test`, 0 failures (incl. real captured `event_replay`); credential/rejection + reconnect harnesses | — | — |
| Grouping / filters / composer rule | full algebra + hysteresis boundary sweep | — | queue path |
| UI flows F1–F7 | F1–F5 + F7 + F6-negative RUN GREEN in the integrated `PiDashboardUITests` target (xcodebuild, iOS 26.3.1 sim) | F6-positive SKIPS pending the build-CC `-uitest-reconnecting` hook | haptics, server-restart states |

**Bottom line:** every Kit logic + contract surface of the MVP is ✅ green via
`swift test` (565, grounded in REAL captured payloads, not impressions), AND every
UI flow F1–F7 RUNS GREEN end-to-end in the integrated XCUITest target (11 e2e
methods pass + the build-CC smoke; F6-positive skips on the documented pending
hook). Tranche-1 credential/rejection T2 harnesses and targeted T3 Simulator tests
run green. Physical OAuth/Keychain acceptance remains ⛔ UNRUN. Deferred rows are
MVP-scope exclusions per DESIGN §7.
