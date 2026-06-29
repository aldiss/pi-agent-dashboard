import Foundation

/// A palette of design tokens. UI-free: plain hex strings the SwiftUI layer maps
/// to `Color`. Mirrors the `:root` custom properties in
/// `packages/client/src/index.css`. The dashboard ships three palettes (modern
/// dark [default], modern light, warm-paper); the native app keeps them swappable.
public struct ThemePalette: Sendable, Equatable {
    public let bgPrimary: String      // page background
    public let bgSecondary: String    // panels, sidebar
    public let bgTertiary: String     // cards, inputs, selected
    public let bgSurface: String      // badges, buttons, elevated
    public let bgSelected: String
    public let bgCode: String         // code blocks, tool output
    public let textPrimary: String
    public let textSecondary: String
    public let textTertiary: String
    public let textFaint: String
    public let borderPrimary: String
    public let borderSecondary: String
    public let borderSubtle: String
    public let accentPrimary: String
    public let accentBlue: String
    public let accentGreen: String
    public let accentRed: String
    public let accentOrange: String
    public let accentYellow: String
    public let accentPurple: String
}

public enum DashboardTheme {
    /// Default DARK palette (the operator's). Every hex lifted verbatim from
    /// `index.css :root` dark. `textPrimary/Secondary/Tertiary` were provisional
    /// in the design pass and are now lifted exactly (#e5e5e5 / #b0b0b0 / #808080);
    /// `textFaint` (#3a3a3a) + all `bg-*`/`border-*`/`accent-*` confirmed from source.
    public static let dark = ThemePalette(
        bgPrimary: "#0a0a0a",
        bgSecondary: "#141414",
        bgTertiary: "#1e1e1e",
        bgSurface: "#2a2a2a",
        bgSelected: "#1e1e1e",
        bgCode: "#1a1a1a",
        textPrimary: "#e5e5e5",
        textSecondary: "#b0b0b0",
        textTertiary: "#808080",
        textFaint: "#3a3a3a",
        borderPrimary: "#252525",
        borderSecondary: "#333333",
        borderSubtle: "#252525",
        accentPrimary: "#3b82f6",
        accentBlue: "#3b82f6",
        accentGreen: "#22c55e",
        accentRed: "#ef4444",
        accentOrange: "#f97316",
        accentYellow: "#eab308",
        accentPurple: "#a855f7"
    )

    /// Status chip accent mapping (active→green, streaming→blue, idle→muted,
    /// ended→faint). Mirrors the dashboard's status-chip coloring.
    public static func statusColor(_ status: String?, _ p: ThemePalette = dark) -> String {
        switch status {
        case "active": return p.accentGreen
        case "streaming": return p.accentBlue
        case "idle": return p.textSecondary
        case "ended": return p.textFaint
        default: return p.textTertiary
        }
    }
}
