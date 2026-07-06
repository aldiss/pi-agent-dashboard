import SwiftUI
import PiDashboardKit

/// Hex → SwiftUI `Color`. Maps the core's UI-free `ThemePalette` hex strings
/// (lifted from `index.css :root`) onto real colors. Supports `#rgb`, `#rrggbb`,
/// `#rrggbbaa` and the `rgba(r,g,b,a)` form a couple of tokens use.
extension Color {
    init(hex raw: String) {
        let s = raw.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("rgba(") || s.hasPrefix("rgb(") {
            self = Color.parseRGBA(s) ?? .clear
            return
        }
        var hex = s
        if hex.hasPrefix("#") { hex.removeFirst() }
        // Expand shorthand #rgb → #rrggbb
        if hex.count == 3 {
            hex = hex.map { "\($0)\($0)" }.joined()
        }
        var value: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&value)
        let r, g, b, a: Double
        switch hex.count {
        case 8:
            r = Double((value >> 24) & 0xFF) / 255
            g = Double((value >> 16) & 0xFF) / 255
            b = Double((value >> 8) & 0xFF) / 255
            a = Double(value & 0xFF) / 255
        default: // 6 (or malformed → black)
            r = Double((value >> 16) & 0xFF) / 255
            g = Double((value >> 8) & 0xFF) / 255
            b = Double(value & 0xFF) / 255
            a = 1
        }
        self = Color(.sRGB, red: r, green: g, blue: b, opacity: a)
    }

    private static func parseRGBA(_ s: String) -> Color? {
        guard let open = s.firstIndex(of: "("), let close = s.firstIndex(of: ")") else { return nil }
        let inner = s[s.index(after: open)..<close]
        let parts = inner.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count >= 3,
              let r = Double(parts[0]), let g = Double(parts[1]), let b = Double(parts[2]) else { return nil }
        let a = parts.count >= 4 ? (Double(parts[3]) ?? 1) : 1
        return Color(.sRGB, red: r / 255, green: g / 255, blue: b / 255, opacity: a)
    }
}

/// The active palette mapped to SwiftUI colors — the app's single theme surface.
/// Dark default is the operator's; the struct stays swappable (light/warm exist in
/// the core's token set) but the MVP ships dark only.
struct Theme {
    let palette: ThemePalette
    static let dark = Theme(palette: DashboardTheme.dark)
    static let light = Theme(palette: DashboardTheme.light)

    /// Resolve the theme the UI renders from the operator's skin + mode + the current
    /// OS appearance (for `.system`). Thin `Color`-layer wrapper over the core's pure
    /// `DashboardTheme.resolvePalette(skin, mode, systemIsDark)`.
    static func resolve(_ skin: Skin, _ mode: ThemeMode, systemIsDark: Bool) -> Theme {
        Theme(palette: DashboardTheme.resolvePalette(skin, mode, systemIsDark: systemIsDark))
    }

    var bgPrimary: Color { Color(hex: palette.bgPrimary) }
    var bgSecondary: Color { Color(hex: palette.bgSecondary) }
    var bgTertiary: Color { Color(hex: palette.bgTertiary) }
    var bgSurface: Color { Color(hex: palette.bgSurface) }
    var bgHover: Color { Color(hex: palette.bgHover) }
    var bgCode: Color { Color(hex: palette.bgCode) }
    var bgOverlay: Color { Color(hex: palette.bgOverlay) }
    var textPrimary: Color { Color(hex: palette.textPrimary) }
    var textSecondary: Color { Color(hex: palette.textSecondary) }
    var textTertiary: Color { Color(hex: palette.textTertiary) }
    var textMuted: Color { Color(hex: palette.textMuted) }
    var textFaint: Color { Color(hex: palette.textFaint) }
    var borderPrimary: Color { Color(hex: palette.borderPrimary) }
    var borderSecondary: Color { Color(hex: palette.borderSecondary) }
    var accentBlue: Color { Color(hex: palette.accentBlue) }
    var accentGreen: Color { Color(hex: palette.accentGreen) }
    var accentRed: Color { Color(hex: palette.accentRed) }
    var accentOrange: Color { Color(hex: palette.accentOrange) }
    var accentYellow: Color { Color(hex: palette.accentYellow) }
    var accentPurple: Color { Color(hex: palette.accentPurple) }
    var accentCyan: Color { Color(hex: palette.accentCyan) }
    var link: Color { Color(hex: palette.link) }
    var linkHover: Color { Color(hex: palette.linkHover) }
    var shadowCard: Color { Color(hex: palette.shadowCard) }

    // Semantic session-status accents (the session-list color language).
    var statusActive: Color { Color(hex: palette.statusActive) }
    var statusWorking: Color { Color(hex: palette.statusWorking) }
    var statusNeedsInput: Color { Color(hex: palette.statusNeedsInput) }
    var statusUnread: Color { Color(hex: palette.statusUnread) }
    var statusError: Color { Color(hex: palette.statusError) }
    var statusEnded: Color { Color(hex: palette.statusEnded) }

    /// Status-chip color via the core's mapping (active→green, streaming→blue, …).
    func statusColor(_ status: String?) -> Color {
        Color(hex: DashboardTheme.statusColor(status, palette))
    }

    /// The single semantic hue a session-list card carries (rail + dot + status
    /// text) — core `sessionAccent` precedence mapped to a `Color`.
    func sessionAccent(_ session: DashboardSession, hasError: Bool = false) -> Color {
        Color(hex: DashboardTheme.sessionAccent(session, hasError: hasError, palette))
    }

    /// Tint color for a card's state-pulse, or nil for a calm card.
    func pulseAccent(_ kind: CardPulseKind) -> Color? {
        DashboardTheme.pulseAccent(kind, palette).map(Color.init(hex:))
    }

    // MARK: Chat color language (batch 2)

    /// Subtle role accent for a chat row (border rule / tint), or nil for a role
    /// that renders on the plain surface (assistant prose, separators).
    func roleAccent(_ role: ChatRole) -> Color? {
        ChatColors.roleAccent(role, palette).map(Color.init(hex:))
    }

    /// Tool-call status hue (running→amber, complete→green, error→red).
    func toolStatusColor(_ status: ToolStatus?) -> Color {
        Color(hex: ChatColors.toolStatusAccent(status, palette))
    }

    /// Code-fence token color for a syntax kind. `.plain` → the default code
    /// foreground (`textSecondary`); the rest read as a colorful theme on dark.
    func syntaxColor(_ kind: SyntaxTokenKind) -> Color {
        switch kind {
        case .plain:   return textSecondary
        case .keyword: return accentPurple
        case .string:  return accentGreen
        case .comment: return textTertiary
        case .number:  return accentOrange
        case .type:    return accentCyan
        }
    }
}

/// Lightweight environment access so views read `theme` without prop-drilling.
private struct ThemeKey: EnvironmentKey {
    static let defaultValue = Theme.dark
}
extension EnvironmentValues {
    var theme: Theme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}
