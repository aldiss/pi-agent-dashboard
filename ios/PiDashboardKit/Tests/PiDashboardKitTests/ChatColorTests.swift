import XCTest
@testable import PiDashboardKit

/// Chat-view color language (color batch 2): the pure role→accent, tool-status→
/// accent, and code-tokenizer logic the native chat renders off. Verified via
/// `swift test`, no simulator. Reuses the batch-1 semantic palette.
final class ChatColorTests: XCTestCase {
    private let p = DashboardTheme.dark

    // MARK: role accents

    func testRoleAccents() {
        XCTAssertEqual(ChatColors.roleAccent(.user, p), p.accentBlue)
        XCTAssertEqual(ChatColors.roleAccent(.thinking, p), p.accentPurple)
        XCTAssertEqual(ChatColors.roleAccent(.toolResult, p), p.accentYellow)
        XCTAssertEqual(ChatColors.roleAccent(.bashOutput, p), p.accentGreen)
        XCTAssertEqual(ChatColors.roleAccent(.commandFeedback, p), p.textTertiary)
        XCTAssertEqual(ChatColors.roleAccent(.rawEvent, p), p.textTertiary)
        XCTAssertNil(ChatColors.roleAccent(.assistant, p), "assistant prose is uncolored")
        XCTAssertNil(ChatColors.roleAccent(.turnSeparator, p))
    }

    // MARK: tool-status accents

    func testToolStatusAccents() {
        XCTAssertEqual(ChatColors.toolStatusAccent(.running, p), p.accentYellow)  // amber
        XCTAssertEqual(ChatColors.toolStatusAccent(.complete, p), p.accentGreen)
        XCTAssertEqual(ChatColors.toolStatusAccent(.error, p), p.accentRed)
        XCTAssertEqual(ChatColors.toolStatusAccent(nil, p), p.textTertiary)
    }

    /// Running is amber, NOT blue — the batch-2 fix (native used accentBlue before).
    func testRunningIsAmberNotBlue() {
        XCTAssertNotEqual(ChatColors.toolStatusAccent(.running, p), p.accentBlue)
        XCTAssertEqual(ChatColors.toolStatusAccent(.running, p), p.accentYellow)
    }

    // MARK: tokenizer — classification

    private func kinds(_ code: String, _ lang: String? = nil) -> [SyntaxTokenKind] {
        SyntaxHighlighter.tokenize(code, language: lang).map(\.kind)
    }

    func testTokenizerKeyword() {
        let toks = SyntaxHighlighter.tokenize("let x", language: "swift")
        XCTAssertEqual(toks.first, SyntaxToken("let", .keyword))
    }

    func testTokenizerString() {
        let toks = SyntaxHighlighter.tokenize("x = \"hi\"", language: "swift")
        XCTAssertTrue(toks.contains(SyntaxToken("\"hi\"", .string)))
    }

    func testTokenizerSingleQuoteAndTemplateStrings() {
        XCTAssertTrue(SyntaxHighlighter.tokenize("a = 'hi'", language: "js").contains(SyntaxToken("'hi'", .string)))
        XCTAssertTrue(SyntaxHighlighter.tokenize("a = `hi`", language: "js").contains(SyntaxToken("`hi`", .string)))
    }

    func testTokenizerSlashComment() {
        let toks = SyntaxHighlighter.tokenize("x // note", language: "swift")
        XCTAssertEqual(toks.last, SyntaxToken("// note", .comment))
    }

    func testTokenizerBlockComment() {
        let toks = SyntaxHighlighter.tokenize("a /* b */ c", language: "swift")
        XCTAssertTrue(toks.contains(SyntaxToken("/* b */", .comment)))
    }

    /// `#` is a comment for shell/python, but NOT for Swift (`#selector`) — the
    /// language gate that keeps a Swift directive from being greyed out.
    func testHashCommentIsLanguageGated() {
        XCTAssertTrue(SyntaxHighlighter.tokenize("x # note", language: "bash").contains(SyntaxToken("# note", .comment)))
        let swift = SyntaxHighlighter.tokenize("x # note", language: "swift")
        XCTAssertFalse(swift.contains(where: { $0.kind == .comment }), "# is not a Swift comment")
    }

    func testTokenizerNumbers() {
        XCTAssertTrue(SyntaxHighlighter.tokenize("n = 42", language: "swift").contains(SyntaxToken("42", .number)))
        XCTAssertTrue(SyntaxHighlighter.tokenize("f = 3.14", language: "swift").contains(SyntaxToken("3.14", .number)))
        XCTAssertTrue(SyntaxHighlighter.tokenize("h = 0xFF", language: "swift").contains(SyntaxToken("0xFF", .number)))
    }

    func testTokenizerType() {
        // Leading-uppercase identifier → type.
        XCTAssertTrue(SyntaxHighlighter.tokenize("let v: Foo", language: "swift").contains(SyntaxToken("Foo", .type)))
    }

    /// Loss-less: concatenating every token's text reconstructs the input exactly.
    func testTokenizerIsLossless() {
        let samples = [
            "func greet(name: String) -> Int { return 42 } // ok",
            "x = 'a'\n# comment\nprint(x)",
            "const y = `t${1}`; /* block */",
            "",
            "plain text no code",
        ]
        for s in samples {
            let rebuilt = SyntaxHighlighter.tokenize(s).map(\.text).joined()
            XCTAssertEqual(rebuilt, s, "tokens must reconstruct the source")
        }
    }
}
