# Native iPhone pi-dashboard — Design Pass (SwiftPilot)

Status: design pass, night 1 (iPhone). Base commit `dda5919`. Worktree branch `feat/native-ios-app`.
North Star: the current pi-dashboard PWA, as it exists today. Same UX / look / feel, adapted natively.

This is a **real native app** (Swift / SwiftUI). NOT a PWA, NOT a WebView shell. The app re-implements
the dashboard's browser-protocol client and data models natively, speaking the **exact same** server
contract the web client speaks.

---

## 1. Why SwiftUI (+ a SwiftPM core)

- **SwiftUI** for UI: declarative, maps cleanly onto the dashboard's React mental model (sessions →
  list, events → reduced chat state), first-class on Xcode 26.2 / Swift 6.2.3, fastest path to parity
  on iPhone, native keyboard-avoidance / safe-area / haptics / photo picker.
- **SwiftPM core package (`PiDashboardKit`)** holds ALL non-UI logic: Codable protocol models, the
  WebSocket client, the REST client, the session grouping/filter logic, the chat event reducer.
  - Load-bearing reason: `PiDashboardKit` builds + tests via `swift test` on the **command line with
    zero simulator dependency**. The entire contract + logic layer is verifiable immediately and in CI,
    independent of the simulator. The SwiftUI app target is a thin shell over the package; the
    simulator is only needed to *run* the UI and for XCUITest.

```
ios/
  DESIGN.md                      ← this file
  PiDashboardKit/                ← SwiftPM package (CLI-testable core; no UIKit/SwiftUI import)
    Package.swift
    Sources/PiDashboardKit/
      Models/                    ← Codable mirrors of packages/shared/src/types.ts
      Protocol/                  ← Browser<->Server WS message envelopes (browser-protocol.ts)
      Net/                       ← DashboardClient (URLSession WebSocket + REST)
      Sessions/                  ← grouping + filters (session-grouping.ts port)
      Chat/                      ← event reducer (event-reducer.ts port)
      Theme/                     ← design tokens (index.css :root port)
    Tests/PiDashboardKitTests/
      Fixtures/                  ← REAL captured /api payloads (grounding contract tests)
  PiDashboard/                   ← SwiftUI app target (Xcode project; depends on PiDashboardKit)
```

## 2. The server contract (source of truth)

The native client is, precisely, a second implementation of the **browser** side of the dashboard
protocol. Authoritative TS sources (read to the letter):

| Concern | TS source | Swift target |
|---|---|---|
| Data models | `packages/shared/src/types.ts` | `Models/*` Codable structs |
| Server→Browser WS | `packages/shared/src/browser-protocol.ts` `ServerToBrowserMessage` | `Protocol/ServerMessage.swift` (decode) |
| Browser→Server WS | same, `BrowserToServerMessage` | `Protocol/ClientMessage.swift` (encode) |
| REST | `packages/shared/src/rest-api.ts` (`ApiResponse<T>` envelope) | `Net/RestClient.swift` |
| Grouping/filters | `packages/client/src/lib/session-grouping.ts` | `Sessions/SessionGrouping.swift` |
| Chat reduce | `packages/client/src/lib/event-reducer.ts` | `Chat/EventReducer.swift` |
| Theme | `packages/client/src/index.css` `:root` | `Theme/Tokens.swift` |

### Connection lifecycle (the heart)
1. Connect WS to `ws(s)://<host>:<port>/` (browser gateway). Server immediately pushes
   `sessions_snapshot { sessions[], orders }` — client REPLACES its registry (no merge; drops stale ids).
2. Live deltas: `session_added` / `session_updated {updates: Partial<DashboardSession>}` /
   `session_removed` / `sessions_reordered` / `pinned_dirs_updated`.
3. Open a session detail → send `subscribe { sessionId, lastSeq? }`. Server replies with batched
   `event_replay { events:[{seq,event}], isLast }` then live `event { seq, event }`.
4. Compose → `send_prompt { sessionId, text, images?, queueNonce? }`. Failure signal:
   `send_prompt_failed { queueNonce, reason }` (bridge absent). Abort → `abort { sessionId }`.
5. `session_view` / `session_unview` tell the server which session is on screen (drives unread bit).

`DashboardSession` (the big model) and `DashboardEvent {eventType, timestamp, data}` are the two core
types. `session_updated.updates` is a partial patch — Swift decode must treat every session field as
optional and merge patches onto the existing value.

## 3. MVP surfaces (night 1, iPhone)

Validated against the PWA mobile shell (`MobileShell.tsx`) + composer (`MobileComposer.tsx`).

1. **Connect screen** — configurable server URL (localhost / Tailscale), optional bearer token.
   Persist known servers (mirrors `KnownServer` + `/api/known-servers`). Health probe via `/api/health`.
2. **Session list** — same grouping/labels/status as the dashboard:
   - PRIMARY tier grouping (`classifyTier`): standing-crew → drivers → cell-executor →
     operator-chat-pane → worker → other.
   - SECONDARY directory grouping (pinned dirs first), `groupCwd` (worktree) honored.
   - Per-card: display name (name → firstMessage → cwd basename), status chip
     (active/idle/streaming/ended), model + thinking, context-% bar (`contextTokens/contextWindow`),
     git branch, unread stripe, driver progress + next-engagement badge, last-activity relative time.
   - Toggles: Folders on/off, hide-stale (threshold hrs), show-hidden, search (query filter).
3. **Session detail / chat** — reduced event stream (text / thinking / tool calls + results / turn-end
   stats / subagents). Markdown rendering. Scrollback + live append.
4. **Composer** — the adaptive single-row ⇄ multiline native composer (§4). Send / queue-while-working
   / stop. Image attach (PhotosUI). (Voice → Phase 1.1.)
5. **Status / health** — connection banner (disconnected > 3s), safe error states (spawn errors,
   bridge-absent send failure, server restarting).

## 4. Adaptive composer spec (ported to native, behavior-identical)

From `MobileComposer.tsx` @ `dda5919` — preserve the exact behavior:

- **Two layouts, one stable view tree** (no remount → no focus loss), class/layout toggled by
  `isMultiline`:
  - single-row (empty / 1 line): `[+ attach] [text field flex] [mic] [stop?] [send]`, min height ~48.
  - column (multiline): text field full-width on top; `[+ attach]` left + `[mic][stop?][send]` right below.
- **Flip rule with hysteresis** (port verbatim, constants 45/20 preserved):
  `isMultiline = hasNewline ? true : (prev ? text.count > 20 : sh > 45 && text.count > 20)`
  where `sh` is the measured content height. Entry-floor and revert-floor both 20 → no flip-flop pocket.
  Native: measure intrinsic text height; empty → reset to 36pt; else clamp height to [36, 200]pt.
- **Enter inserts newline, NEVER sends** (mobile). Send only via the Send button.
- **Send button**: filled white when sendable (non-empty trimmed text OR ≥1 image), ghost otherwise;
  arrow-up glyph. Tappable WHILE streaming → queues (server queues via bridge `deliverAs:"followUp"`);
  optimistic `queuedCount` badge ("N queued") above the card. **Stop** is ADDITIVE (red) when working.
- **Attach (+)** → native photo picker (PhotosUI `PHPickerViewController`), multi-select,
  jpeg/png/gif/webp → `ImageContent {type:"image", data:base64, mimeType}`.
- **Haptics**: success on send (`UINotificationFeedbackGenerator`), warning on stop.
- Keyboard avoidance + bottom safe-area: native (keyboard layout guide + safe area), replacing the
  PWA's `--keyboard-h` CSS-var hack. Composer hugs the bottom; content clears the home indicator.

## 5. Theme tokens (default dark — operator's)

Port `index.css :root` (dark default). Make them swappable tokens (light + warm-paper themes exist).

```
bgPrimary   #0a0a0a   (page)        textPrimary    (TBD from css; near #ededed)
bgSecondary #141414   (panels)      textSecondary  (muted)
bgTertiary  #1e1e1e   (cards/input) textTertiary   (faint)
bgSurface   #2a2a2a   (elevated)    textFaint      #3a3a3a
bgSelected  #1e1e1e                 borderPrimary  #252525
bgCode      #1a1a1a                 borderSecondary#333333
accentPrimary/blue #3b82f6   green #22c55e   red #ef4444
accentOrange #f97316   yellow #eab308   purple #a855f7
```
Status chip colors map to accents (active→green, streaming→blue, idle→muted, ended→faint).
(Exact `--text-*` hex to be lifted from `index.css` during build.)

## 6. Test strategy (the e2e suite is part of the product)

- **Unit** (`swift test`, no sim): grouping/filters (`classifyTier`, `filterStale`, `filterByQuery`,
  `sortSessionsByOrder`, `rankActiveFirst`), composer hysteresis rule, context-% math, display-name
  fallback, event reducer transitions.
- **Contract / fixture** (`swift test`, no sim): decode REAL captured payloads
  (`/api/sessions`, `/api/health`, WS `sessions_snapshot`, `event_replay`) into the Codable models —
  asserts the Swift contract matches the live server byte-shapes. Fixtures captured from the running
  dashboard (`Tests/.../Fixtures/`).
- **UI** (XCUITest, simulator): connect → list renders tiers → open session → composer single-row⇄
  multiline flip → type → send. Screenshots for visual parity vs the PWA.
- **Parity checklist** (`ios/PARITY.md`): each PWA behavior ↔ native behavior ↔ test id.

## 7. Deferred tonight (explicit, with rationale)

- **Physical-device install** — needs the operator's Apple Developer Team ID / signing identity in
  Xcode (cannot self-provision). Tonight = simulator build + run + tests. (Q1 to operator.)
- **Full OAuth2 web-login** — the dashboard supports OAuth/JWT for Tailscale remote w/ allowlist.
  Tonight = URL + optional bearer-token connect; OAuth login surface is Phase 2. (Q2 to operator.)
- **Voice push-to-talk**, terminals, editor proxy, package management, flow/architect dashboards,
  settings depth — out of MVP; the protocol layer leaves room for them. Not load-bearing for the
  core session-list → chat → compose loop.
- **iPad / macOS** — later nights (the SwiftPM core is shared substrate for both).

## 8. Build plan (author ≠ verifier)

- SwiftPilot (driver): authors this design + the `PiDashboardKit` core skeleton + Codable models +
  grouping + fixtures + the first passing `swift test`; verifies all CC output (build, test, screenshots).
- Supervised CC (via `cc-launch`): builds the SwiftUI app target + screens (connect / list / chat /
  composer) + XCUITest against this spec + the green core. Driver reviews every claim, runs the
  builds/tests, catches drift. No fire-and-forget.
