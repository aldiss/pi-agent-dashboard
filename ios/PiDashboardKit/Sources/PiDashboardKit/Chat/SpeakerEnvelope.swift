import Foundation

/// Removes the model-facing `<speaker …>` envelope from operator-facing text.
/// Stored/agent-facing content remains unchanged.
///
/// The extension wraps an authenticated operator message as:
///
///     <speaker id="…" name="…" nonce="X">\n{body}\n</speaker nonce="X">
///
/// `speaker-wrap.ts` sanitizes literal speaker-tag tokens and the nonce out of
/// the human body before adding this envelope. A speaker token in model-facing
/// content is therefore envelope chrome, not user content.
public enum SpeakerEnvelope {
    /// Open or close speaker-tag token. Attribute parsing is deliberately not
    /// attempted: malformed attributes are exactly where a nonce must not leak.
    private static let tokenRegex = try? NSRegularExpression(
        pattern: "<\\/?\\s*speaker\\b", options: [.caseInsensitive])

    /// Locate a tag's closing `>` while respecting quoted attribute values.
    /// An unmatched quote makes the remainder untrusted (nil → discard it).
    private static func tagClose(in content: String, from start: String.Index) -> String.Index? {
        var index = start
        var quote: Character?
        while index < content.endIndex {
            let character = content[index]
            if let activeQuote = quote {
                if character == activeQuote { quote = nil }
            } else if character == "\"" || character == "'" {
                quote = character
            } else if character == ">" {
                return index
            }
            index = content.index(after: index)
        }
        return nil
    }

    /// Remove every speaker tag, including nonce-bearing close tags.
    ///
    /// This scanner is more conservative than the PWA's newline-bounded regex:
    /// it removes from a speaker token through the next unquoted `>` even when
    /// attributes span lines or contain `>`. If no safe close exists, it discards
    /// the remainder. Thus malformed attributes cannot strand a nonce outside the
    /// removed range. One adjacent envelope newline on each side is removed; body
    /// newlines are preserved.
    public static func stripForDisplay(_ content: String) -> String {
        guard !content.isEmpty, let tokenRegex else { return content }

        var output = ""
        var cursor = content.startIndex
        var foundToken = false

        while cursor < content.endIndex {
            let searchRange = NSRange(cursor..<content.endIndex, in: content)
            guard let match = tokenRegex.firstMatch(in: content, range: searchRange),
                  let tokenRange = Range(match.range, in: content) else {
                output += content[cursor..<content.endIndex]
                break
            }
            foundToken = true

            // Preserve text before the tag, except the envelope's own preceding
            // line break. CRLF and LF are both handled.
            var prefixEnd = tokenRange.lowerBound
            if prefixEnd > cursor {
                let before = content[..<prefixEnd]
                if before.hasSuffix("\r\n") {
                    // CRLF is one extended grapheme cluster in Swift.String.
                    prefixEnd = content.index(before: prefixEnd)
                } else if before.hasSuffix("\n") {
                    prefixEnd = content.index(before: prefixEnd)
                }
            }
            output += content[cursor..<prefixEnd]

            // Scan through `>` without treating a newline as a tag boundary.
            // No closing bracket means the tag remainder is untrusted: drop it.
            guard let close = tagClose(in: content, from: tokenRange.lowerBound) else {
                cursor = content.endIndex
                break
            }

            cursor = content.index(after: close)
            // Remove the envelope's following line break, not body formatting.
            if cursor < content.endIndex {
                if content[cursor...].hasPrefix("\r\n") {
                    // CRLF is one Character; advancing twice skips body text.
                    cursor = content.index(after: cursor)
                } else if content[cursor] == "\n" {
                    cursor = content.index(after: cursor)
                }
            }
        }

        return foundToken ? output : content
    }

    /// Comparison key for matching a wrapped server echo to the clean optimistic
    /// row or queue card created from what the operator typed.
    public static func reconcileKey(_ content: String) -> String {
        stripForDisplay(content).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
