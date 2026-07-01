import SwiftUI
import MarkdownUI
import PiDashboardKit

/// A colorful, dependency-free code-syntax highlighter for MarkdownUI fenced code
/// blocks. Delegates classification to the core `SyntaxHighlighter` (pure, pinned
/// by `swift test`), then paints each token with the theme's syntax palette —
/// keyword violet, string green, comment gray, number orange, type cyan — so code
/// reads as a real theme on dark rather than monochrome. `Theme` is a plain value
/// captured at construction (no environment access needed inside the fence).
struct DashboardSyntaxHighlighter: CodeSyntaxHighlighter {
    let theme: Theme

    func highlightCode(_ code: String, language: String?) -> Text {
        let tokens = SyntaxHighlighter.tokenize(code, language: language)
        guard !tokens.isEmpty else { return Text(code) }
        return tokens.reduce(Text("")) { acc, token in
            acc + Text(token.text).foregroundColor(theme.syntaxColor(token.kind))
        }
    }
}

/// Markdown renderer for chat prose (assistant + user), wrapping `MarkdownUI` themed
/// to the dashboard dark palette: headings, lists, bold/italic, blockquotes, inline
/// code, **fenced code blocks** (colorful syntax highlighting, horizontally
/// scrollable for long lines), tables, and tappable links (open in Safari). Replaces
/// the prior `AttributedString(markdown:)` inline-only renderer for real PWA parity.
struct MarkdownText: View {
    let content: String
    @Environment(\.theme) private var theme

    var body: some View {
        Markdown(content)
            .markdownTheme(dashboardMarkdownTheme)
            .markdownTextStyle { ForegroundColor(theme.textPrimary) }
            .markdownCodeSyntaxHighlighter(DashboardSyntaxHighlighter(theme: theme))
            .tint(theme.accentBlue) // link color
            .textSelection(.enabled)
    }

    /// Dark-palette MarkdownUI theme mapped from `DashboardTheme` tokens.
    private var dashboardMarkdownTheme: MarkdownUI.Theme {
        MarkdownUI.Theme()
            .text {
                ForegroundColor(theme.textPrimary)
            }
            .link {
                ForegroundColor(theme.accentBlue)
            }
            .code {
                FontFamilyVariant(.monospaced)
                FontSize(.em(0.92))
                ForegroundColor(theme.accentOrange)
                BackgroundColor(theme.bgCode)
            }
            .strong { FontWeight(.semibold) }
            .heading1 { config in
                VStack(alignment: .leading, spacing: 4) {
                    config.label
                        .markdownTextStyle {
                            FontWeight(.bold); FontSize(.em(1.5)); ForegroundColor(theme.textPrimary)
                        }
                    Divider().overlay(theme.borderSecondary)
                }
                .padding(.top, 6)
            }
            .heading2 { config in
                config.label
                    .markdownTextStyle {
                        FontWeight(.bold); FontSize(.em(1.3)); ForegroundColor(theme.textPrimary)
                    }
                    .padding(.top, 4)
            }
            .heading3 { config in
                config.label
                    .markdownTextStyle {
                        FontWeight(.semibold); FontSize(.em(1.12)); ForegroundColor(theme.textPrimary)
                    }
                    .padding(.top, 2)
            }
            .blockquote { config in
                HStack(spacing: 8) {
                    RoundedRectangle(cornerRadius: 2).fill(theme.borderSecondary).frame(width: 3)
                    config.label
                        .markdownTextStyle { ForegroundColor(theme.textSecondary) }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            .codeBlock { config in
                ScrollView(.horizontal, showsIndicators: false) {
                    config.label
                        .markdownTextStyle {
                            // No ForegroundColor here — the syntax highlighter paints
                            // each token; a blanket color would flatten it back to mono.
                            FontFamilyVariant(.monospaced); FontSize(.em(0.88))
                        }
                        .padding(12)
                }
                .background(theme.bgCode)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(theme.borderPrimary, lineWidth: 1))
                .markdownMargin(top: 6, bottom: 6)
            }
    }
}
