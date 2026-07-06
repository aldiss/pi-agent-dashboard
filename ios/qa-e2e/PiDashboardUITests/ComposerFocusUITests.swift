import XCTest
import PiDashboardKit

/// COMPOSER-FOCUS REGRESSION — the composer must KEEP its draft + first-responder
/// across the single-row⇄multiline flip AND while a session streams (the operator's
/// daily bug: "typing, the session is working, the keyboard just closes and the draft
/// is lost"). This spec DEFINES success for the composer-focus fix
/// (`composer-focus-bug-brief.md`, `AdaptiveComposer.swift` + `GrowingTextView.swift`).
///
/// Root cause it guards (all three compound):
///   1. `AdaptiveComposer.card` puts `textEditor` in STRUCTURALLY DIFFERENT positions
///      in the two branches (`if isMultiline { VStack{textEditor…} } else { HStack{…
///      textEditor…} }`) → the flip gives the `UITextView` a new SwiftUI identity →
///      it's torn down + rebuilt → resigns first responder → keyboard dismisses.
///   2. Streaming re-renders (ChatView re-renders on every incoming event) spuriously
///      flip `isMultiline` via the per-`updateUIView` height recalc → teardown per #1.
///   3. A text-binding race lets a re-render clobber the in-flight character.
/// The FIXED composer keeps ONE stable textEditor position across both layouts, flips
/// `isMultiline` only on real text change, and never echoes the user's own edit back
/// into the field — so focus + draft survive the flip and the stream.
///
/// TWO TIERS (the F6-positive / echo-send precedent):
///   • HERMETIC (runs today) — the flip-teardown reproduces by simply TYPING across the
///     boundary while focused; no server events needed. These are the durable guard.
///   • STREAMING / VOICE (skip pending a build hook) — the LITERAL "events streaming
///     while typing" + programmatic voice-append need an app-side pump; the suite can't
///     touch app sources (cc-ios-tests owns qa-e2e only) and every stream/send path
///     no-ops behind `!isUITest`. Those specs drive a to-be-built launch-arg contract
///     and `XCTSkip` with a precise coordination note if it isn't wired — authored +
///     ready, never a false red. (Reported to cc-ios-build via SwiftPilot.)
///
/// MARKER technique: drafts are whitespace-joined runs of unique uppercase+digit tokens
/// (`MK01 MK02 …`). Uppercase-with-digits are non-dictionary → iOS autocorrect /
/// predictive text leave them untouched, so the exact typed text is recoverable from the
/// field value and per-marker accumulation is assertable. The spaces let a line WRAP
/// (→ height growth → the single-row⇄multiline flip) with no single un-wrappable token.
@MainActor
final class ComposerFocusUITests: PiDashboardUITestCase {

    // MARK: HERMETIC — focus + draft survive the single-row⇄multiline flip (runs today)

    /// The core repro, no streaming required: focus the composer, type a short entry
    /// (single-row), then a long WRAPPING entry that crosses into multiline WHILE the
    /// field is focused. Assert the flip did NOT (a) dismiss the keyboard, (b) reset or
    /// drop the draft, or (c) resign first responder — proven by continuing to type
    /// (without re-tapping) and watching the draft ACCUMULATE onto the same field.
    /// This alone catches the if/else teardown (#1) + the binding clobber (#3).
    func testComposerKeepsTextAndFocusAcrossMultilineFlip() {
        enterSeededChat()

        let tv = focusComposer()
        XCTAssertTrue(waitForComposerLayout("single-row"), "the composer starts single-row")
        attach("focus-single-row")

        // A short (≤20) entry stays single-row and is retained.
        tv.typeText(markers(1...2) + " ")                       // "MK01 MK02 "
        XCTAssertTrue(waitForComposerLayout("single-row"), "a short entry stays single-row")
        XCTAssertTrue(waitForValueContains(tv, "MK02"), "the short entry is retained")

        // A long, wrapping entry crosses single-row→multiline WHILE focused (the flip).
        tv.typeText(markers(3...18) + " ")                      // wraps past height 45 + count 20
        XCTAssertTrue(waitForComposerLayout("multiline"), "a long wrapping entry flips to multiline")
        attach("focus-multiline")

        // (a) the flip did NOT tear the field down — the keyboard is STILL up.
        XCTAssertTrue(keyboardIsUp(),
            "crossing single-row→multiline must NOT dismiss the keyboard (no UITextView teardown)")

        // (b) the draft is intact across the flip — earliest AND latest marker present,
        //     and the field is NOT reset to its empty placeholder.
        XCTAssertTrue(waitForValueContains(tv, "MK01"), "earliest marker retained across the flip")
        XCTAssertTrue(waitForValueContains(tv, "MK18"), "latest marker retained across the flip")
        XCTAssertNotEqual(composerValue(tv), "Message", "the field is not reset to the empty placeholder")

        // (c) the field is STILL first responder — typing MORE, WITHOUT re-tapping,
        //     appends onto the SAME draft. Had the flip resigned first responder this
        //     type would land nowhere and the accumulation check would catch the loss.
        XCTAssertTrue(keyboardIsUp(), "still focused before continuing to type")
        tv.typeText(" " + markers(19...24))
        XCTAssertTrue(waitForValueContains(tv, "MK24"), "post-flip typing accumulates onto the draft")
        XCTAssertTrue(waitForValueContains(tv, "MK01"), "the original text survives the extra typing")
        XCTAssertTrue(waitForComposerLayout("multiline"), "stays multiline as typing continues")
        attach("focus-accumulated")
    }

    /// Stress the SAME teardown path under repeated re-layout: type the draft in many
    /// chunks that keep pushing across the boundary (a newline chunk forces multiline
    /// directly — also the "Enter never sends" contract under pressure). Never re-tap:
    /// each chunk must land on the still-focused field and the value must only GROW.
    /// This is the closest hermetic proxy for the streaming re-render churn (#2).
    func testComposerDraftAccumulatesUnderRepeatedReLayout() {
        enterSeededChat()

        let tv = focusComposer()
        XCTAssertTrue(waitForComposerLayout("single-row"), "starts single-row")

        var through = 0
        for chunk in 0..<6 {
            let lo = through + 1, hi = through + 5
            // Alternate a newline vs a space separator: the newline (hasNewline → true)
            // forces multiline directly AND must never send; the space lets width-wrap
            // drive the flip. Both exercise re-layout without a re-tap.
            let piece = (chunk.isMultiple(of: 2) ? "\n" : " ") + markers(lo...hi)
            XCTAssertTrue(keyboardIsUp(), "keyboard still up before chunk \(chunk) (no mid-type teardown)")
            tv.typeText(piece)
            XCTAssertTrue(waitForValueContains(tv, String(format: "MK%02d", hi)),
                          "chunk \(chunk): the just-typed markers accumulate")
            XCTAssertTrue(waitForValueContains(tv, "MK01"),
                          "chunk \(chunk): the draft is never reset — the first marker survives")
            through = hi
        }

        // A newline was inserted → multiline, and Enter never sent (the whole draft is
        // still here). The field is still focused at the end of the run.
        XCTAssertTrue(waitForComposerLayout("multiline"), "newlines / a large draft → multiline")
        XCTAssertTrue(keyboardIsUp(), "the field is still focused at the end of the stress run")

        // Every marker MK01…MKnn is present in one accumulated draft (no gaps, no reset).
        let value = composerValue(tv)
        for i in 1...through {
            XCTAssertTrue(value.contains(String(format: "MK%02d", i)),
                          "MK\(String(format: "%02d", i)) present in the final accumulated draft")
        }
        attach("focus-stress-accumulated")
    }

    /// The bonus send-path contract, hermetic: a GENUINE send clears the composer. The
    /// store's `sendPrompt` no-ops under `-uitest` (never mutates a live session), but
    /// `AdaptiveComposer.send()` resets text/images/isMultiline LOCALLY regardless — so
    /// after send the field goes empty, reverts to single-row, and send disables again.
    func testGenuineSendClearsTheField() {
        enterSeededChat()

        let tv = focusComposer()
        tv.typeText(markers(1...16))                            // a multiline-length draft
        XCTAssertTrue(waitForComposerLayout("multiline"), "the draft is multiline before send")
        let send = waitFor("mobile-composer-send", 6)
        XCTAssertTrue(send.isEnabled, "send is enabled with a non-empty draft")
        attach("send-before")

        send.tap()

        // A real send clears the field: empty draft, reverted to single-row, send off.
        XCTAssertTrue(waitForComposerLayout("single-row", timeout: 8),
                      "after send the composer reverts to single-row")
        XCTAssertTrue(waitForValueEmpty(tv), "after send the draft is cleared")
        XCTAssertFalse(send.isEnabled, "send is disabled again once the field is cleared")
        attach("send-cleared")
    }

    // MARK: STREAMING — the literal repro (skips pending a `-uitest-stream` build hook)

    /// The operator's EXACT choreography: while the session is WORKING (events streaming
    /// in), focus the composer, cross into multiline, and keep typing "a lot" across
    /// multiple passes. Assert the keyboard is never dismissed, the draft only GROWS
    /// (no characters lost, no reset to empty), and no spurious single-row teardown
    /// happens mid-type — even as ChatView re-renders on every incoming event.
    ///
    /// PENDING build-session hook: fixture mode seeds a SETTLED chat and every stream /
    /// send path no-ops behind `!isUITest`, so there is no live event source to drive
    /// the re-render churn hermetically. It needs a small app affordance: under a
    /// `-uitest-stream` launch argument, `DashboardStore` should drive synthetic events
    /// into the VIEWED session's `ChatSessionState` on a repeating timer (thinking /
    /// message_update deltas + tool start/end — no network) so `state.isStreaming` is
    /// true and ChatView re-renders per event. Until it lands this SKIPS with this note
    /// (it does not fail). App-target change = cc-ios-build owned (reported to SwiftPilot).
    /// The hermetic `testComposerDraftAccumulatesUnderRepeatedReLayout` guard runs today.
    func testComposerSurvivesLiveStreamingWhileTyping() throws {
        enterSeededChat(["-uitest-stream"])

        // Detect the pump: under the hook the viewed session goes isStreaming → the
        // composer shows Stop (`mobile-composer-stop`) and/or the chat grows new rows.
        // Plain `-uitest` seeds a settled chat (no stream) → skip.
        guard streamingIsLive() else {
            throw XCTSkip("""
            No live streaming under -uitest-stream (fixture mode seeds a SETTLED chat and every \
            stream/send path no-ops behind `!isUITest`). PENDING build-session hook: under a \
            `-uitest-stream` launch argument, DashboardStore should drive synthetic events into the \
            VIEWED session's ChatSessionState on a repeating timer (thinking/message_update deltas + \
            tool start/end, no network) so `state.isStreaming` is true and ChatView re-renders on \
            every event — exactly the condition that fired the operator's composer teardown. Reported \
            to cc-ios-build (guards the composer-focus fix). Spec authored + ready; the hermetic \
            re-layout guard runs today.
            """)
        }
        attach("stream-live-detected")

        // Focus + cross into multiline WHILE events stream in.
        let tv = focusComposer()
        tv.typeText(markers(1...16))
        XCTAssertTrue(waitForComposerLayout("multiline"), "the draft crosses to multiline while streaming")
        XCTAssertTrue(keyboardIsUp(),
                      "a streaming re-render must not tear the field down at the flip")

        // Keep typing "a lot" across several passes while the session streams; each
        // incoming event re-renders ChatView (the isMultiline-churn trigger). The field
        // must stay focused, the layout must stay multiline, and the draft must only grow.
        var through = 16
        for pass in 0..<5 {
            XCTAssertTrue(keyboardIsUp(), "keyboard still up before streaming pass \(pass)")
            let lo = through + 1, hi = through + 6
            tv.typeText(" " + markers(lo...hi))
            XCTAssertTrue(waitForValueContains(tv, String(format: "MK%02d", hi)),
                          "pass \(pass): the new markers accumulate under streaming")
            XCTAssertTrue(waitForValueContains(tv, "MK01"),
                          "pass \(pass): the draft is never reset mid-stream")
            XCTAssertEqual(composerLayoutValue(), "multiline",
                           "pass \(pass): no spurious single-row teardown mid-type")
            through = hi
            usleep(400_000)   // let more events interleave between passes
        }

        XCTAssertTrue(keyboardIsUp(), "focus retained through the whole streaming type-a-lot run")
        let value = composerValue(tv)
        for i in 1...through {
            XCTAssertTrue(value.contains(String(format: "MK%02d", i)),
                          "MK\(String(format: "%02d", i)) intact after streaming + heavy typing")
        }
        attach("stream-live-accumulated")
    }

    // MARK: VOICE — programmatic append preserves the draft (skips pending a hook)

    /// Bonus: a programmatic voice-append composes a transcript onto the EXISTING draft
    /// (`AdaptiveComposer.toggleMic` → `voice.toggle` → `text = composed` via the core
    /// `TranscriptAppender`) — it must never CLEAR the draft or drop the caret.
    ///
    /// PENDING build-session hook: real recording needs AVAudioSession capture + the
    /// parakeet transcription sidecar, neither reachable in the hermetic sim. It needs a
    /// NO-OP affordance: under `-uitest-voice-append`, expose a voice path that appends a
    /// fixed transcript token to the current draft via `TranscriptAppender` WITHOUT touching
    /// AVAudioSession, so the append-preserves-draft contract is drivable. Until that pure
    /// no-op lands this SKIPS (it does not fail).
    ///
    /// IMPORTANT — do NOT tap the mic on the sim: tapping `mobile-composer-mic` invokes the
    /// REAL `VoiceRecorder.toggle` → AVAudioSession capture, which HANGS the app's main run
    /// loop on a headless simulator (~315 s → the harness kills the test as a spurious
    /// failure). The current `-uitest-voice-append` wiring enables the mic but the tap still
    /// hits real capture (not a pure no-op), so this test SKIPS before any tap. Re-enable the
    /// tap+assert only once the hook appends via `TranscriptAppender` with NO AVAudioSession
    /// access (a sim-safe path, e.g. gated on `-uitest-voice-append` inside `VoiceRecorder`).
    func testVoiceAppendKeepsDraftAndCaret() throws {
        enterSeededChat(["-uitest-voice-append"])

        let tv = focusComposer()
        tv.typeText(markers(1...4))                            // a small existing draft
        XCTAssertTrue(waitForValueContains(tv, "MK04"), "the seed draft is present before the append")

        // Never tap the mic on the sim — a real AVAudioSession capture hangs the main thread.
        throw XCTSkip("""
        Voice-append not drivable sim-safely: tapping `mobile-composer-mic` triggers the real \
        VoiceRecorder → AVAudioSession capture, which HANGS the app main run loop on a headless \
        simulator (~315 s, killed as a spurious failure). The `-uitest-voice-append` hook currently \
        enables the mic but the tap still hits real capture. PENDING build-session hook: append a \
        fixed transcript via `TranscriptAppender` under `-uitest-voice-append` WITHOUT any \
        AVAudioSession access, so the append-preserves-draft/caret contract runs without recording. \
        Then re-enable the tap+assert here. Reported to cc-ios-build. Spec authored + ready.
        """)
    }

    /// The programmatic-append LAYOUT-FLIP regression (the voice-cramping residual,
    /// diagnosed by ComposerMender): a long, no-newline line set in ONE shot must flip
    /// the composer to `multiline`, not stay cramped in the single-row slot.
    ///
    /// WHY the deterministic seed (not a real mic): `TranscriptAppender.append` joins with
    /// a SPACE, so a dictation is one long NO-NEWLINE line — the `text.contains("\n")`
    /// fast-flip never fires, and the layout must flip purely off the async wrapped HEIGHT.
    /// The `-uitest-composer-overflow` probe drives the SAME code path with zero mic: it
    /// auto-opens the first fixture chat and seeds the composer via `AdaptiveComposer`'s
    /// `onAppear` `initialText` path (the programmatic-append site the fix arms) with
    /// `UITestFixtures.composerOverflowLine` — a ~200-char, single-line, no-newline string
    /// that wraps far past the single-row width. No AVAudioSession, no hang.
    ///
    /// RED→GREEN contract (the empirical proof Portico's sim confirms):
    ///   • WITHOUT the fix: the one-shot seed recomputes `isMultiline` against the STALE
    ///     pre-seed height (~minHeight) → stays `single-row` (the cramped bug). RED.
    ///   • WITH the fix: the async wrapped height lands, `pendingProgrammaticLayout` fires
    ///     ONE recompute → flips to `multiline`. GREEN.
    /// Asserts on the `mobile-composer-card` a11y value (`single-row`/`multiline`) — the
    /// native analogue of the PWA `test-10` (filled 96 vs typed 48 → GREEN on the web side).
    func testProgrammaticLongLineSeedFlipsToMultiline() {
        // The overflow probe implies fixture mode AND auto-opens + seeds — its own launch
        // path (not `enterSeededChat`, which would not seed). `-uitest` keeps mutation
        // guards active. No mic is ever touched.
        launch(["-uitest", UITestFixtures.composerOverflowLaunchArg])

        // The probe boots straight into the seeded chat; the composer mounts with the
        // long no-newline draft already applied via its onAppear `initialText` path.
        _ = waitFor("mobile-composer", 8)
        _ = waitFor("mobile-composer-card", 6)

        // THE ASSERT: the programmatically-seeded long line drives the composer to
        // multiline (RED without the fix — stays `single-row`; GREEN with it). A generous
        // timeout: the flip depends on the async wrapped-height landing then the one-shot
        // recompute, so it is NOT instantaneous on first paint.
        XCTAssertTrue(waitForComposerLayout("multiline", timeout: 8),
            """
            A long, no-newline line set in ONE shot (voice/seed programmatic append) must flip the \
            composer to multiline. Staying `single-row` is the cramping residual: the one-shot text \
            set recomputes against the stale pre-append height and never re-flips once the real \
            wrapped height lands. (Fix: `pendingProgrammaticLayout` re-flips on the async height.)
            """)
        attach("programmatic-seed-multiline")
    }

    // MARK: helpers

    /// Launch fixture mode (+ optional extra args like `-uitest-stream`) → open a fixture
    /// session whose `chat(for:)` renders rows — a realistic re-render surface for the
    /// composer to sit under.
    private func enterSeededChat(_ extra: [String] = []) {
        launch(Self.fixtureArgs + extra)
        connectAndEnterList()
        openChatBearing()
    }

    /// Focus the composer input and confirm the keyboard actually came up. Returns the
    /// textarea element for subsequent typing (never re-tapped by the focus-survival
    /// specs — the whole point is that focus persists without a re-tap).
    @discardableResult
    private func focusComposer() -> XCUIElement {
        let tv = waitFor("mobile-composer-textarea", 6)
        tv.tap()
        XCTAssertTrue(waitForKeyboard(), "the keyboard comes up when the composer is focused")
        return tv
    }

    /// Whether the software keyboard is currently presented — the observable proxy for
    /// "the composer's UITextView is first responder". A teardown that resigns first
    /// responder dismisses the keyboard, flipping this false.
    private func keyboardIsUp() -> Bool { app.keyboards.firstMatch.exists }

    /// Poll until the keyboard is presented (or the deadline passes). Deadline-poll
    /// shape (no self-capturing NSPredicate) — keeps Swift 6 strict-concurrency clean.
    private func waitForKeyboard(_ timeout: TimeInterval = 6) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if app.keyboards.firstMatch.exists { return true }
            usleep(120_000)
        }
        return app.keyboards.firstMatch.exists
    }

    /// The composer's current text value (empty string if unset). An empty UITextView
    /// reports its placeholder ("Message"); a non-empty one reports the typed text.
    private func composerValue(_ tv: XCUIElement) -> String { (tv.value as? String) ?? "" }

    /// Poll until the composer value CONTAINS `needle` (SwiftUI/UIKit publish the value
    /// asynchronously after a type). Proves a marker landed + is still present.
    @discardableResult
    private func waitForValueContains(_ tv: XCUIElement, _ needle: String,
                                     _ timeout: TimeInterval = 6) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if composerValue(tv).contains(needle) { return true }
            usleep(120_000)
        }
        return composerValue(tv).contains(needle)
    }

    /// Poll until the composer value is empty — literally "" OR the "Message"
    /// placeholder an emptied UITextView reports.
    private func waitForValueEmpty(_ tv: XCUIElement, _ timeout: TimeInterval = 6) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let v = composerValue(tv)
            if v.isEmpty || v == "Message" { return true }
            usleep(120_000)
        }
        let v = composerValue(tv)
        return v.isEmpty || v == "Message"
    }

    /// Detect a live stream on the viewed session: the composer's Stop control appears
    /// (`isWorking` == `state.isStreaming`) and/or the chat grows new rows over the
    /// window. Either is sufficient evidence the `-uitest-stream` pump is driving events.
    private func streamingIsLive(_ timeout: TimeInterval = 6) -> Bool {
        let start = chatRowCount()
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if el("mobile-composer-stop").exists { return true }
            if chatRowCount() > start { return true }
            usleep(200_000)
        }
        return el("mobile-composer-stop").exists || chatRowCount() > start
    }

    /// Count of rendered chat message ROWS (`chat-message-<id>`), excluding the per-row
    /// sub-markers (`-time` / `-pending` / `-failed`) so the count reflects real rows.
    private func chatRowCount() -> Int {
        app.descendants(matching: .any).allElementsBoundByIndex.reduce(into: 0) { acc, e in
            let id = e.identifier
            if id.hasPrefix("chat-message-"),
               id != "chat-message-time", id != "chat-message-pending", id != "chat-message-failed" {
                acc += 1
            }
        }
    }

    /// A whitespace-joined run of unique `MKnn` marker tokens (see the file docblock).
    private func markers(_ range: ClosedRange<Int>) -> String {
        range.map { String(format: "MK%02d", $0) }.joined(separator: " ")
    }
}
