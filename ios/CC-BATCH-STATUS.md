# CC-BATCH-STATUS — Parity Batch 1: rich chat rendering

Branch `feat/native-ios-tests`. Owner: cc-ios-build. First parity batch — the chat
rendered plain text; now it renders like the PWA. NOT reinstalled — SwiftPilot
verifies (screenshots) + installs on the operator's iPhone(s), testing against the
isolated server (`http://127.0.0.1:8001` / Tailscale :8001). Team `ZPD66G9CB6`
preserved; no AI attribution; `qa-e2e/**` + test-CC tests untouched.

## What now renders richly
1. **Markdown** (assistant + user + streaming text) via **MarkdownUI**
   (`gonzalezreal/swift-markdown-ui` 2.4.x, MIT) — headings, lists, bold/italic,
   blockquotes, links, inline code, **fenced code blocks**, tables. Themed to the
   dark palette (`MarkdownText.swift` maps `DashboardTheme` tokens → MarkdownUI
   `Theme`). Replaced the prior inline-only `AttributedString(markdown:)`.
2. **Code blocks** — monospaced on `bgCode`, bordered, **horizontally scrollable**
   for long lines (matches the official MarkdownUI codeBlock idiom).
3. **Expandable tool calls** — collapsed = compact row (icon + name + status +
   duration + 1-line result peek); tap the chevron → **Input** (pretty-printed args
   JSON) + **Output** (`result`, monospaced, h-scroll, truncated at 30 lines with a
   "Show more"). Pure helpers (`ChatRender.prettyArgs` / `.truncated`) are unit-tested.
4. **Inline images + lightbox** — `message.images` render as rounded capped
   thumbnails; tap → full-screen **`ImageLightbox`** (pinch-zoom via
   `MagnificationGesture`, drag-pan when zoomed, double-tap zoom, swipe-down/tap to
   dismiss, dark backdrop). Owned by `ChatView` via `.fullScreenCover(item:)`.
5. **Collapsible thinking** — muted "Thinking" header + chevron; **default collapsed
   when long** (`ChatRender.shouldCollapseThinking`, 280-char threshold; unit-tested),
   open for short asides.
6. **Tappable links** — open in Safari (MarkdownUI link handling + `.tint(accentBlue)`).

Deferred (later batches, per brief): rich diffs, mermaid, markdown search,
syntax-highlighting (code is monospaced-but-unhighlighted for now — still a big jump).

## Files
| File | Change |
|---|---|
| `ios/PiDashboard/project.yml` | + MarkdownUI SwiftPM package + app-target dep (team/signing preserved) |
| `ios/PiDashboard/Sources/MarkdownText.swift` | **new** — dark-themed MarkdownUI renderer (headings/lists/links/inline+fenced code/blockquote) |
| `ios/PiDashboard/Sources/ImageLightbox.swift` | **new** — full-screen zoom/pan/dismiss image viewer |
| `ios/PiDashboard/Sources/ChatMessageRow.swift` | rewired: markdown bubbles, expandable tool detail, collapsible thinking, tappable images |
| `ios/PiDashboard/Sources/ChatView.swift` | lightbox `.fullScreenCover`, `onImageTap` wiring, markdown streaming text |
| `ios/PiDashboard/Sources/FixtureData.swift` | enriched seed chat (markdown/code/tool args+result/inline image) for verification |
| `ios/PiDashboardKit/Sources/.../Chat/ChatRender.swift` | **new (core, pure)** — `prettyArgs`, `shouldCollapseThinking`, `truncated` |
| `ios/PiDashboardKit/Tests/.../ChatRenderTests.swift` | **new** — 7 tests for the pure helpers |

## Build / test (real)
```
# core floor (cd ios/PiDashboardKit && swift test)
Executed 174 tests, with 0 failures (0 unexpected)     # 167 → +7 ChatRender

# app build (cd ios/PiDashboard && xcodegen generate && xcodebuild … build)
xcodebuild -project PiDashboard.xcodeproj -scheme PiDashboard \
  -destination 'generic/platform=iOS Simulator' build
** BUILD SUCCEEDED **          # MarkdownUI + cmark-gfm resolved + compiled
```
Per-piece screenshotting was skipped this batch by operator direction (host load
~500 → sim builds crawling); SwiftPilot does the verification screenshots. The build
compiles clean and the seed chat (Joan) carries markdown + code + a tool call w/
args+result + an inline image so the render is visible on first open.

## On-device check steps for SwiftPilot
1. `cd ios/PiDashboard && xcodegen generate` (re-resolves MarkdownUI from project.yml),
   re-sign + install (team `ZPD66G9CB6`). Connect to the isolated server (:8001).
2. Open a session with real assistant output → confirm **markdown** (headings, lists,
   **bold**, links) + **fenced code** render (mono on a code background, h-scroll).
3. Tap a **tool row** → it expands to show Input (args JSON) + Output (result); long
   results show "Show more".
4. A message with an **image** → tap it → full-screen lightbox; pinch-zoom, drag,
   swipe-down to dismiss.
5. A long **thinking** block is collapsed by default → tap to expand.
6. Tap a **link** → opens Safari.

Everything from prior batches (composer hysteresis, voice/parakeet, send-optimistic
+ queue + timestamps + model-picker) intact; `swift test` green.
