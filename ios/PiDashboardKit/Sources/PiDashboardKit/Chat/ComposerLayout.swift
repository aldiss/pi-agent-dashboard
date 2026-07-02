import Foundation

/// Pure port of the `MobileComposer` adaptive single-row ⇄ column layout decision,
/// with asymmetric hysteresis. Mirrors `MobileComposer.tsx` @ dda5919:
///
///     isMultiline = hasNewline ? true
///                              : (prev ? text.length > 20
///                                      : sh > 45 && text.length > 20)
///
/// Entry-floor and revert-floor share 20 ⇒ no unstable flip-flop pocket. Constants
/// 45 (wrap height) / 20 (length floor) preserved verbatim. The SwiftUI composer
/// and the unit tests share this single source of truth.
public enum ComposerLayout {
    public static let columnLengthFloor = 20
    public static let wrapHeightThreshold: Double = 45
    public static let minHeight: Double = 36
    public static let maxHeight: Double = 200

    /// Decide the adaptive layout. `previous` is the current `isMultiline` state;
    /// `contentHeight` is the measured intrinsic height of the text.
    public static func isMultiline(previous: Bool, text: String, contentHeight: Double) -> Bool {
        if text.contains("\n") { return true }
        if previous { return text.count > columnLengthFloor }
        return contentHeight > wrapHeightThreshold && text.count > columnLengthFloor
    }

    /// Clamp measured text height to the composer band; empty resets to the
    /// single-line floor. Mirrors the auto-grow effect (empty → 36; else [36, 200]).
    public static func clampedHeight(text: String, measured: Double) -> Double {
        if text.isEmpty { return minHeight }
        return min(max(minHeight, measured), maxHeight)
    }

    /// Send enabled when not disabled AND (trimmed text non-empty OR ≥1 image).
    /// Mirrors `canSend` (NOT gated on isWorking — tap-to-queue while streaming).
    public static func canSend(text: String, imageCount: Int, disabled: Bool) -> Bool {
        if disabled { return false }
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || imageCount > 0
    }

    /// Should a SwiftUI binding value be pushed into the live `UITextView`?
    ///
    /// The composer's `@State text` can LAG the text view during a streaming
    /// re-render fired right after the user typed a key: `updateUIView` then runs with
    /// a stale `boundText`, and blindly assigning it back would drop the in-flight
    /// character + reset the caret (the reported draft-loss bug). Rule:
    ///  - `fieldText == boundText` → nothing to do (no-op).
    ///  - `isProgrammatic` (send-clear, voice-append) → ALWAYS apply, even while the
    ///    field is first responder (the composer explicitly set the value).
    ///  - `boundText.isEmpty` → apply (a clear is always safe + intended).
    ///  - otherwise apply ONLY when the field is NOT first responder — an idle field
    ///    can accept an external value; a focused field must never be clobbered by a
    ///    lagging re-render echo of the user's own edit.
    public static func shouldApplyBinding(fieldText: String, boundText: String,
                                          isFirstResponder: Bool, isProgrammatic: Bool) -> Bool {
        if fieldText == boundText { return false }
        if isProgrammatic { return true }
        if boundText.isEmpty { return true }
        return !isFirstResponder
    }
}
