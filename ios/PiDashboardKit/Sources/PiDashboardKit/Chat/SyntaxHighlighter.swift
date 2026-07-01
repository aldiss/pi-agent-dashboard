import Foundation

/// One classified run of source text. `kind` drives the color the app assigns; the
/// SwiftUI layer never re-parses — it just concatenates colored `Text` per token.
public struct SyntaxToken: Sendable, Equatable {
    public let text: String
    public let kind: SyntaxTokenKind
    public init(_ text: String, _ kind: SyntaxTokenKind) {
        self.text = text; self.kind = kind
    }
}

/// The token classes a code fence gets colored by — a compact, language-agnostic
/// set that reads well on dark (keyword violet, string green, comment gray, number
/// orange, type cyan). `plain` is uncolored (default code foreground).
public enum SyntaxTokenKind: String, Sendable, Equatable {
    case plain, keyword, string, comment, number, type
}

/// Dependency-free, best-effort source tokenizer for chat code fences (color batch
/// 2). NOT a full parser — a pragmatic lexer that colors the constructs that carry
/// most of the visual signal across the languages pi sessions emit (Swift / TS-JS /
/// Python / shell / JSON). Pure + `Sendable` so the classification is pinned by
/// `swift test`; the app maps `SyntaxTokenKind` → `Color` and builds the `Text`.
///
/// Design notes:
///  - String literals: `"..."`, `'...'`, and backtick templates; single-line
///    (a run that hits EOL before its close still ends at EOL — no multi-line
///    string spill).
///  - Comments: `//…` and `#…` to end-of-line, `/* … */` block. `#` is a comment
///    ONLY for hash-comment languages (shell/python/ruby/yaml) OR unknown language,
///    so a Swift `#selector` / CSS `#id` is not mis-greyed.
///  - Numbers: decimal, float, `0x…` hex.
///  - Identifiers: keyword set → `.keyword`; leading-uppercase → `.type`; else plain.
public enum SyntaxHighlighter {

    /// Broad keyword union across the common languages — kept as one set so a single
    /// pass colors keywords regardless of the fence's declared language (a code
    /// sample is short; cross-language false positives are visually harmless).
    static let keywords: Set<String> = [
        // control flow / decls (Swift, JS/TS, Python, common)
        "func", "let", "var", "const", "if", "else", "for", "while", "do", "switch",
        "case", "default", "break", "continue", "return", "guard", "defer", "in",
        "class", "struct", "enum", "protocol", "extension", "interface", "type",
        "import", "export", "from", "public", "private", "internal", "static",
        "final", "override", "async", "await", "throws", "throw", "try", "catch",
        "new", "delete", "typeof", "instanceof", "void", "yield",
        "def", "elif", "lambda", "pass", "with", "as", "not", "and", "or", "is",
        "self", "super", "this", "nil", "null", "none", "true", "false", "undefined",
        "function", "fn", "impl", "trait", "match", "where", "mut", "use", "mod",
        // shell
        "echo", "then", "fi", "esac", "done", "local", "export", "source",
    ]

    /// Languages where a leading `#` starts a line comment.
    static let hashCommentLangs: Set<String> = [
        "sh", "bash", "shell", "zsh", "python", "py", "ruby", "rb", "yaml", "yml",
        "toml", "makefile", "make", "dockerfile", "perl", "r",
    ]

    /// Tokenize `code` for an optional fence `language`. Returns a flat run of tokens
    /// whose concatenated `text` reconstructs `code` exactly (loss-free).
    public static func tokenize(_ code: String, language: String? = nil) -> [SyntaxToken] {
        let hashComments = language.map { hashCommentLangs.contains($0.lowercased()) } ?? true
        let chars = Array(code)
        var tokens: [SyntaxToken] = []
        var i = 0
        let n = chars.count

        func flushPlain(_ buf: inout [Character]) {
            if !buf.isEmpty { tokens.append(SyntaxToken(String(buf), .plain)); buf.removeAll(keepingCapacity: true) }
        }
        var plain: [Character] = []

        while i < n {
            let c = chars[i]

            // Line comment: // or (hash-lang) #
            if c == "/" && i + 1 < n && chars[i + 1] == "/" {
                flushPlain(&plain)
                var j = i
                while j < n && chars[j] != "\n" { j += 1 }
                tokens.append(SyntaxToken(String(chars[i..<j]), .comment)); i = j; continue
            }
            if c == "#" && hashComments {
                flushPlain(&plain)
                var j = i
                while j < n && chars[j] != "\n" { j += 1 }
                tokens.append(SyntaxToken(String(chars[i..<j]), .comment)); i = j; continue
            }
            // Block comment: /* … */
            if c == "/" && i + 1 < n && chars[i + 1] == "*" {
                flushPlain(&plain)
                var j = i + 2
                while j + 1 < n && !(chars[j] == "*" && chars[j + 1] == "/") { j += 1 }
                j = min(j + 2, n)
                tokens.append(SyntaxToken(String(chars[i..<j]), .comment)); i = j; continue
            }
            // String literal: " ' or `
            if c == "\"" || c == "'" || c == "`" {
                flushPlain(&plain)
                let quote = c
                var j = i + 1
                while j < n && chars[j] != quote && chars[j] != "\n" {
                    if chars[j] == "\\" && j + 1 < n { j += 2 } else { j += 1 }
                }
                if j < n && chars[j] == quote { j += 1 } // include closing quote
                tokens.append(SyntaxToken(String(chars[i..<j]), .string)); i = j; continue
            }
            // Number: decimal / float / 0x hex
            if c.isNumber {
                flushPlain(&plain)
                var j = i
                if c == "0" && i + 1 < n && (chars[i + 1] == "x" || chars[i + 1] == "X") {
                    j = i + 2
                    while j < n && chars[j].isHexDigit { j += 1 }
                } else {
                    while j < n && (chars[j].isNumber || chars[j] == "." || chars[j] == "_") { j += 1 }
                }
                tokens.append(SyntaxToken(String(chars[i..<j]), .number)); i = j; continue
            }
            // Identifier: keyword / Type / plain
            if c.isLetter || c == "_" {
                var j = i
                while j < n && (chars[j].isLetter || chars[j].isNumber || chars[j] == "_") { j += 1 }
                let word = String(chars[i..<j])
                if keywords.contains(word) {
                    flushPlain(&plain)
                    tokens.append(SyntaxToken(word, .keyword))
                } else if let first = word.first, first.isUppercase {
                    flushPlain(&plain)
                    tokens.append(SyntaxToken(word, .type))
                } else {
                    plain.append(contentsOf: word)
                }
                i = j; continue
            }
            // Anything else → plain char
            plain.append(c); i += 1
        }
        flushPlain(&plain)
        return tokens
    }
}
