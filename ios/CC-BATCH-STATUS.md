# CC-BATCH-STATUS — chat UX batch (scroll · send · timestamps · queue · model-picker)

Branch `feat/native-ios-tests`. Owner: cc-ios-build. Five operator-reported items,
committed together. NOT reinstalled — SwiftPilot installs the whole batch on BOTH
iPhones together. `swift test` 132 → **167 green**; `xcodebuild generic/iOS
Simulator` **BUILD SUCCEEDED**.

## 1. Streaming scroll jitter (ChatView)
Root cause: an ANIMATED `scrollTo("chat-bottom")` re-fired on every message-count
change during a streaming turn → overshoot/bounce, never smoothly following
`streamingText`. Fix: `.defaultScrollAnchor(.bottom)` (natural bottom-pin as content
grows) + a NON-animated auto-follow on BOTH `messages.count` AND `streamingText`,
gated to only follow when already near the bottom (a `BottomDistanceKey` geometry
probe vs the viewport) so a manual scroll-up isn't yanked back. No animation on the
follow — that was the jitter source.

## 2. Optimistic send + dedup + surfaced failures (DashboardStore + reducer)
- **Optimistic echo**: `sendPrompt` appends the user bubble (`delivery: .pending`)
  the instant Send is tapped — shows immediately like the PWA.
- **Dedup**: the server's `message_start(role:user)` echo CONFIRMS the matching
  pending bubble in place (trimmed-content match, most-recent-first) instead of
  appending a duplicate → no double bubble.
- **Surfaced failures**: `client.send` throw OR `send_prompt_failed` flips the bubble
  to `.failed` + sets `sendFailures[sid]` (was silently swallowed). Failed bubbles
  show "Not sent"; pending show "Sending…".
- Core helpers (testable): `appendingOptimisticUser`, `markingLatestOptimisticFailed`,
  `hasPendingOptimisticUser`; reducer dedup in the user arm.

## 3. Per-message timestamps (all rows)
`TimeFormat.clockTime(fromEpochMs:)` → 24-hour `HH:mm` (POSIX-fixed 24h, device
timezone), in the CORE so it's unit-tested; `Format.clockTime` is the app
pass-through. Rendered as a subtle `caption2`/`textTertiary` caption on EVERY
`ChatMessageRow` variant (user trailing; assistant/tool/thinking/bash/cmd/raw
leading; separator excluded). `TimeFormat.isNewDay` + `shortDate` available for an
optional day divider.

## 4. Follow-up QUEUE (send-while-streaming) — PWA parity
- Core: `QueuedMessage{queueNonce,text,images,source,status}` + `queued: []` on
  `ChatSessionState`. `enqueueingOptimistic`, `markingQueuedFailed`,
  `activeQueuedCount`.
- Reducer arms (events arrive via `event_forward`): `message_enqueued`
  (confirm dashboard nonce / append tui-or-unknown), `queue_state` (authoritative
  atomic-REPLACE of the confirmed portion by `followUp` order, pending kept at tail),
  `message_start(queueNonce)` DEQUEUE into a committed bubble. `send_prompt_failed`
  (a ServerMessage) → store marks the queued card failed.
- Store: `sendPrompt` branches on `isStreaming` → enqueue vs optimistic-bubble.
  `retryQueued` re-sends a failed card. Composer `queuedCount` wired to
  `state.activeQueuedCount` (was hardcoded 0). Queued cards rendered above the
  composer (muted + queue glyph; failed → tap-to-retry).

## 5. Model + thinking-level picker (PWA ModelSelector + ModelReasoningSheet)
- Store: `availableModels[sid]` (populated by `models_list`, previously ignored);
  `requestModels` / `setModel` / `setThinkingLevel` via `safeSend`. Current
  model/thinking read from `sessions[sid]` (updated by `session_updated`).
- UI: nav title is now a tappable button (chevron) → `ModelPickerSheet`
  (id `model-picker`): `requestModels` on appear, searchable + provider-chip-filtered
  list of `provider/id` with the current model checkmarked (`model-row-<provider>-<id>`),
  + a thinking-level grid (off/minimal/low/medium/high/xhigh, current highlighted).
  Confirmation flows back through `session_updated` → title + checkmark update.

## Files
| File | Change |
|---|---|
| `…/Chat/EventReducer.swift` | `DeliveryStatus` + optimistic helpers + dedup; `QueuedMessage` + queue helpers + `message_enqueued`/`queue_state`/dequeue arms |
| `…/Chat/TimeFormat.swift` | **new** — `clockTime`/`shortDate`/`isNewDay` (pure) |
| `…/Models/Misc.swift` | `ModelInfo` public init |
| `ios/PiDashboard/Sources/ChatView.swift` | scroll fix + queued cards + tappable model title + sheet |
| `ios/PiDashboard/Sources/ChatMessageRow.swift` | timestamp on every row + delivery footer |
| `ios/PiDashboard/Sources/DashboardStore.swift` | optimistic/queue send + failures + retry + model methods + `availableModels` |
| `ios/PiDashboard/Sources/ModelPickerSheet.swift` | **new** — model + thinking picker |
| `ios/PiDashboard/Sources/Format.swift` | `clockTime` pass-through |
| Tests (new) | `OptimisticEchoTests` (10), `TimeFormatTests` (7), `QueueReducerTests` (13), `ModelPickerWireTests` (6) |

Boundaries: app + `Chat/**` reducer/state + tests only. No `qa-e2e/**` / test-CC
tests touched. Composer hysteresis + send/stop/attach + voice mic all intact.

## On-device test steps for SwiftPilot
1. Install the batch on both iPhones (no reinstall done here). Connect to the Mac URL.
2. **Scroll**: open a streaming session → the chat follows the stream calmly (no
   up/down jitter); scroll up mid-stream → it does NOT yank you back to the bottom.
3. **Send**: send while idle → bubble appears instantly with a time; if the bridge is
   down it shows "Not sent". Server echo doesn't double the bubble.
4. **Timestamps**: every row (user/assistant/tool/…) shows `HH:mm`.
5. **Queue**: send WHILE the agent is streaming → a "N queued" badge + a queued card;
   when the agent picks it up it dequeues into a real message.
6. **Model**: tap the title (claude-… · medium ⌄) → picker → pick a different model →
   title updates + the agent uses it; change thinking level likewise.
