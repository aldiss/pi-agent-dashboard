# CC-VOICE-STATUS — composer voice-input: on-device Speech → PARAKEET backend

Branch `feat/native-ios-tests`. Owner: cc-ios-build. Operator decision ("I don't
need inbuilt.. I need parakeet"): the SFSpeechRecognizer on-device mic shipped in
commit f461142 is **replaced** with a mic that records audio and POSTs it to the
dashboard's **parakeet voice sidecar** — the exact backend the PWA uses (tuned for
Russian). SwiftPilot re-signs + installs on the iPhone and verifies Russian
dictation end-to-end (the sidecar is verified live: `{"healthy":true,"engine":"parakeet"}`).

## What changed (Speech → parakeet)
- **Removed** the on-device path: deleted `SpeechTranscriber.swift`
  (SFSpeechRecognizer + AVAudioEngine live transcription), removed
  `SpeechLocalePicker` from the core, and dropped
  `NSSpeechRecognitionUsageDescription` from `project.yml` + `Info.plist`.
  **Kept** `NSMicrophoneUsageDescription` (parakeet needs mic only).
- **Added** a record→upload mic: `AVAudioRecorder` → temp **m4a** (AAC, mono,
  16 kHz) → `multipart/form-data` POST (field `audio`, `recording.m4a`, `audio/mp4`)
  to `<serverBase>/api/plugins/voice-input/transcribe`, Bearer when a token exists,
  120s timeout. Response `{ transcript }` is trimmed and appended to the draft.
- **Health gate**: polls `<serverBase>/api/plugins/voice-input/health` every 5s while
  the composer is on screen; the mic is disabled (40% + "Voice service starting…")
  until `{"healthy":true}`.
- **Server wiring**: `serverBase` + `token` come from `DashboardStore`
  (`connectedBase` / `connectionToken`) via `ChatView` — NOT hardcoded. On the
  phone this is the Mac's Tailscale/LAN URL, which proxies to its local sidecar.
- **UX (mirrors PWA PushToTalkButton)**: idle (`mic.fill`) → recording (calm
  **accent-blue** pulse ring + `waveform`, NOT red) → uploading (spinner) → idle.
  Errors show inline + auto-clear after ~6s. Safety: 10-min max-record auto-stop;
  background mid-record flushes the upload; min-size guard skips empty clips.
- **Kept intact**: composer hysteresis (`ComposerLayout`), send/queue/stop, attach
  (PhotosUI), haptics. The mic is the same slot/sizing (right controls, before Send).

## Files touched
| File | Change |
|---|---|
| `ios/PiDashboardKit/Sources/PiDashboardKit/Voice/VoiceTranscriber.swift` | **new (core)** — pure transcribe/health URL builders, multipart framing, auth header, `{transcript,engine_used,duration_ms}` + health decode. |
| `ios/PiDashboardKit/Tests/PiDashboardKitTests/VoiceTranscriberTests.swift` | **new** — 19 tests: URLs (incl. trailing-slash + Tailscale), multipart bytes, Bearer present/absent, transcript success/empty/malformed, health 200/503/garbage. |
| `ios/PiDashboardKit/Sources/PiDashboardKit/Chat/VoiceInput.swift` | Removed `SpeechLocalePicker`; kept `TranscriptAppender` (still the draft-join rule). |
| `ios/PiDashboardKit/Tests/PiDashboardKitTests/VoiceInputTests.swift` | Dropped locale tests; kept/expanded append-rule tests. |
| `ios/PiDashboard/Sources/VoiceRecorder.swift` | **new (app)** — `@MainActor @Observable` record→upload engine + health poll + phases + safety. |
| `ios/PiDashboard/Sources/SpeechTranscriber.swift` | **deleted** (dead on-device code). |
| `ios/PiDashboard/Sources/AdaptiveComposer.swift` | Mic rewired to `VoiceRecorder`; phases idle/recording(accent)/uploading; health-gated; takes `serverBase`/`serverToken`. |
| `ios/PiDashboard/Sources/ChatView.swift` | Passes `store.connectedBase` + `store.connectionToken` to the composer. |
| `ios/PiDashboard/Sources/DashboardStore.swift` | Exposes `connectedBase` + `connectionToken`. |
| `ios/PiDashboard/project.yml` + `Sources/Info.plist` | Removed speech key; kept mic key. (Signing/team `ZPD66G9CB6` is the operator's edit — preserved, not mine.) |

Mic a11y id `mobile-composer-mic` (value `idle`/`recording`/`uploading`/`disabled`).
No `qa-e2e/**` or test-CC tests touched.

## Build / test output (real)
```
# core floor (cd ios/PiDashboardKit && swift test)
Executed 132 tests, with 0 failures (0 unexpected)   # was 118: −6 locale, +1 append, +19 transcriber

# app build (cd ios/PiDashboard && xcodegen generate && xcodebuild … build)
Created project at …/PiDashboard.xcodeproj
xcodebuild -project PiDashboard.xcodeproj -scheme PiDashboard \
  -destination 'generic/platform=iOS Simulator' build
** BUILD SUCCEEDED **
```
- Mic render verified visually via an EPHEMERAL UITest (since removed, not
  committed): composer shows `[+] Message … [mic] [↑]`, mic before Send, 40×40. In
  `-uitest` fixture mode there's no live sidecar, so the mic correctly renders
  disabled (health gate) — confirming the gate works.
- SFSpeech removal confirmed: `grep NSSpeechRecognitionUsageDescription` → 0 in both
  `project.yml` and `Info.plist`; `NSMicrophoneUsageDescription` → present.

## On-device test steps for SwiftPilot (device-only — sim can't record/recognize)
1. `cd ios/PiDashboard && xcodegen generate`; re-sign + install (Team `ZPD66G9CB6`).
2. Connect the app to the Mac (Tailscale/LAN URL, e.g. `http://<mac>:8000`) so
   `connectedBase` resolves; confirm the sidecar is up
   (`GET …/api/plugins/voice-input/health` → `{"healthy":true,"engine":"parakeet"}`).
   The mic enables once health is green (else it shows "Voice service starting…").
3. Open a session → composer. Tap the **mic** (right of attach, left of Send).
   First tap prompts **Microphone** only — Allow.
4. Mic shows the **accent-blue pulse** while recording. Dictate in **Russian** (e.g.
   "пингани сервер и покажи логи"). Tap again → **spinner** (uploading) → the
   Russian transcript appends into the field (leading space if the draft had text).
5. Empty/short clip → inline "No speech detected — try again." / "Recording too
   short" — nothing inserted, no crash. Deny mic in Settings → inline
   "Microphone access is off." + Settings button.
6. Confirm hysteresis still flips single-row⇄multiline and send/attach unaffected.

## Acceptance (self)
- `xcodegen generate` clean · `xcodebuild 'generic/platform=iOS Simulator' build`
  **BUILD SUCCEEDED** · `swift test` **132/132 green** · SFSpeech code + speech
  permission removed · hysteresis/send/attach intact.
