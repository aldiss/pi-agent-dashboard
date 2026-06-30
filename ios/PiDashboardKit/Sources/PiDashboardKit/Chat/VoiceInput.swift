import Foundation

/// Pure, UI-free helpers backing the native voice-input (push-to-talk) feature.
/// The Speech-framework engine + mic UI live in the app target; these are the
/// testable rules they depend on, so the locale choice and the transcript-append
/// semantics are pinned by `swift test` with zero Speech/AVFoundation dependency.

/// Appends a (possibly partial) speech transcript onto the existing composer draft.
/// Faithful port of `MobileComposer.tsx` `handleTranscript`:
///
///     const sep = text && !text.endsWith(" ") && !text.endsWith("\n") ? " " : "";
///     return text + sep + transcript;
///
/// For LIVE dictation the caller holds `base` fixed for the recording session and
/// feeds the growing partial as `transcript`, so the field shows `base + partial`
/// updating in place; on the final result the same call commits the text.
public enum TranscriptAppender {
    public static func append(base: String, transcript: String) -> String {
        if base.isEmpty { return transcript }
        let needsSpace = !base.hasSuffix(" ") && !base.hasSuffix("\n")
        return base + (needsSpace ? " " : "") + transcript
    }
}

/// Chooses the speech-recognition locale. v1 rule (brief): prefer Russian (`ru-RU`)
/// when the recognizer supports it — the operator dictates in Russian — otherwise
/// fall back to the device locale. Identifier comparison is separator/case
/// insensitive (`ru_RU` ≡ `ru-RU`). Pure so the choice is unit-tested without the
/// Speech framework (which only enumerates `supportedLocales()` on-device).
public enum SpeechLocalePicker {
    public static let russian = "ru-RU"

    /// - Parameters:
    ///   - available: identifiers the recognizer supports (`SFSpeechRecognizer.supportedLocales()`).
    ///   - device: the device's current locale identifier.
    ///   - preferred: the language to favor when supported (default `ru-RU`).
    /// - Returns: the chosen locale identifier.
    public static func preferred(available: [String], device: String,
                                 preferred: String = russian) -> String {
        func norm(_ s: String) -> String {
            s.replacingOccurrences(of: "_", with: "-").lowercased()
        }
        let avail = Set(available.map(norm))
        if avail.contains(norm(preferred)) { return preferred }
        if avail.contains(norm(device)) { return device }
        // Neither explicitly supported: hand back the device locale and let the
        // recognizer initializer decide (it returns nil for an unsupported locale,
        // which the engine surfaces as an unavailable state — never a crash).
        return device
    }
}
