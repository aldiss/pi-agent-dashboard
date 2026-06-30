import Foundation

/// Pure, UI-free helper backing the composer voice-input feature. The recorder +
/// upload live in the app target; this is the testable transcript→draft join rule
/// they depend on, pinned by `swift test` with zero AVFoundation dependency.

/// Appends a transcript onto the existing composer draft. Faithful port of
/// `MobileComposer.tsx` `handleTranscript`:
///
///     const sep = text && !text.endsWith(" ") && !text.endsWith("\n") ? " " : "";
///     return text + sep + transcript;
///
/// The parakeet recorder appends the final transcript returned by the sidecar onto
/// the current draft (leading space only when the draft is non-empty and doesn't
/// already end in space/newline), preserving focus.
public enum TranscriptAppender {
    public static func append(base: String, transcript: String) -> String {
        if base.isEmpty { return transcript }
        let needsSpace = !base.hasSuffix(" ") && !base.hasSuffix("\n")
        return base + (needsSpace ? " " : "") + transcript
    }
}

