# CC-VOICE-STATUS — native voice-input (push-to-talk mic) for the composer

Branch `feat/native-ios-tests` (the LIVE/installed superset). Owner: cc-ios-build.
Adds a native on-device speech→text mic to the composer, matching the PWA mic UX.
SwiftPilot re-signs + installs on the real iPhone and verifies Russian dictation
end-to-end on-device (the simulator can build + launch but mic/recognition is
limited — no faked device transcription here).

## What was added
- **Tap-to-talk mic** in `AdaptiveComposer`'s right controls group, **before Send**,
  same 40×40 sizing as attach/send. Idle = `mic.fill` on tertiary fill; recording =
  filled red with a pulsing ring + `waveform` glyph.
- **Live on-device transcription** via the iOS Speech framework (`SFSpeechRecognizer`
  + `AVAudioEngine`). Partial results stream into the draft as the operator speaks;
  tap again stops + finalizes.
- **Russian support**: recognizer locale prefers `ru-RU` when supported, else the
  device locale (pure `SpeechLocalePicker`, unit-tested). On-device preferred
  (`requiresOnDeviceRecognition = true` when `supportsOnDeviceRecognition`).
- **Transcript append** matches the PWA `handleTranscript` (leading space only when
  the draft is non-empty and doesn't already end in space/newline) — pure
  `TranscriptAppender`, unit-tested. Live dictation holds the draft as a fixed base
  and feeds the growing partial, so the field shows `base + partial` in place.
- **Permissions**: requests `SFSpeechRecognizer.requestAuthorization` +
  `AVAudioApplication.requestRecordPermission` on first mic tap. Denial → inline hint
  with a **Settings** deep-link; never crashes. Engine/availability errors → a quiet
  inline banner, no crash.

## Files touched
| File | Owner-scope | Change |
|---|---|---|
| `ios/PiDashboardKit/Sources/PiDashboardKit/Chat/VoiceInput.swift` | core (new, allowed) | Pure `TranscriptAppender.append` + `SpeechLocalePicker.preferred`. UI-free. |
| `ios/PiDashboardKit/Tests/PiDashboardKitTests/VoiceInputTests.swift` | core test (new) | 9 tests pinning append semantics + Russian-preference rule. |
| `ios/PiDashboard/Sources/SpeechTranscriber.swift` | app (new) | `@MainActor @Observable` Speech+AVAudioEngine engine: permissions, on-device, live partials, locale, graceful errors. |
| `ios/PiDashboard/Sources/AdaptiveComposer.swift` | app | Mic button + recording state + denial/error hints, wired to `SpeechTranscriber` and the core appender. Hysteresis/send/queue/stop/attach/haptics untouched. |
| `ios/PiDashboard/project.yml` | app | `info.properties`: `NSMicrophoneUsageDescription` + `NSSpeechRecognitionUsageDescription` (durable source of truth — Info.plist is xcodegen-generated + gitignored). |
| `ios/PiDashboard/Sources/Info.plist` | app (gitignored, regenerated) | Same two keys mirrored on disk; xcodegen regenerates with both present. |

Accessibility id for the mic: `mobile-composer-mic` (value `recording`/`idle`) — for
the cc-ios-tests suite. No `qa-e2e/**` or existing tests modified.

## Build / test output (real)
```
# core floor (cd ios/PiDashboardKit && swift test)
Executed 118 tests, with 0 failures (0 unexpected)        # +9 VoiceInput tests, all green

# app build (cd ios/PiDashboard && xcodegen generate && xcodebuild … build)
Created project at …/PiDashboard.xcodeproj
xcodebuild -project PiDashboard.xcodeproj -scheme PiDashboard \
  -destination 'generic/platform=iOS Simulator' build
** BUILD SUCCEEDED **
```
- Mic render verified visually: ran an EPHEMERAL UITest (since removed, not
  committed) through the `-uitest` fixture flow → composer shows
  `[+] Message … [mic] [↑]`, mic before Send, 40×40, tertiary fill — PWA parity.
  Screenshot confirmed the layout (single-row composer intact).

## Known pre-existing warning (NOT introduced here, NOT mine to fix)
`AdaptiveComposer.swift` `attachButton` (PhotosPicker label closure) emits 2 Swift6
warnings: `main actor-isolated property 'theme' can not be referenced from a Sendable
closure` (lines ~113/115). Pre-exists the mic change (it's in the photo-picker label,
untouched). Build still succeeds. Flagging per brief boundary — not editing it as part
of this feature.

## On-device test steps for SwiftPilot (real device — sim can't do recognition)
1. Re-sign + install on the iPhone 14 Pro Max (Team NFHTWP9462, automatic). The two
   usage-description keys are in `project.yml` → regenerate the project first
   (`cd ios/PiDashboard && xcodegen generate`) so the generated Info.plist carries them.
2. Open a session → composer. Tap the **mic** (right of attach, left of Send).
3. First tap: iOS prompts for **Microphone** + **Speech Recognition** — Allow both.
4. Mic turns **red + pulsing**. Dictate in **Russian** (e.g. "пингани сервер и покажи
   логи"). Expect Cyrillic text streaming into the field live as you speak.
5. Tap the mic again → recording stops, final transcript committed. Confirm the text is
   appended (with a separating space if the draft already had content), focus retained,
   and the composer still flips single-row⇄multiline by length (hysteresis intact).
6. Deny-path check: Settings → the app → toggle Microphone OFF → tap mic → expect the
   inline "Microphone or speech access is off." hint with a **Settings** button, no crash.

## Acceptance (self, per brief "Verify")
- `xcodegen generate` → clean. `xcodebuild … 'generic/platform=iOS Simulator' build`
  → **BUILD SUCCEEDED**. `swift test` → **118/118 green**. Hysteresis/send/attach
  untouched (mic is additive in the controls cluster).
