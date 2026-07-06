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
    public let bgHover: String        // row/control hover wash (--bg-hover)
    public let bgSelected: String
    public let bgCode: String         // code blocks, tool output
    public let bgOverlay: String      // scrim behind sheets/dialogs (--bg-overlay)
    public let textPrimary: String
    public let textSecondary: String
    public let textTertiary: String
    public let textMuted: String      // hints, disabled (--text-muted)
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
    public let accentCyan: String
    public let link: String           // hyperlink text (--link)
    public let linkHover: String      // hyperlink hover (--link-hover)
    public let shadowCard: String     // card drop-shadow color (--shadow-card)

    // MARK: Semantic session-status accents

    /// One semantic hue per session state — the session-list color language lifted
    /// from the PWA (`SessionCard.tsx` / `session-status-visuals.ts`). Rail, dot, and
    /// status text share one of these so a card reads by color at a glance.
    ///   active/idle → green · working (streaming) → amber · needs-input → purple ·
    ///   unread → cyan · error → red · ended → faint gray.
    public var statusActive: String { accentGreen }      // green-500  #22c55e
    public var statusWorking: String { accentYellow }    // yellow-500 #eab308
    public var statusNeedsInput: String { accentPurple } // purple-500 #a855f7
    public var statusUnread: String { accentCyan }       // cyan-500   #06b6d4
    public var statusError: String { accentRed }         // red-500    #ef4444
    public var statusEnded: String { textFaint }         // muted gray
}

/// Which animated state-pulse a card carries — the at-a-glance signature. Mirrors
/// the PWA `getCardPulseClass` precedence exactly: needs-YOU beats working beats
/// unread. `.none` → a calm card. Pure/`Sendable` so selection is unit-testable in
/// the core (SwiftUI drives the actual animation off the resolved kind).
public enum CardPulseKind: String, Sendable, Equatable {
    case none, working, needsInput, unread
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
        bgHover: "rgba(255,255,255,0.06)",
        bgSelected: "#1e1e1e",
        bgCode: "#1a1a1a",
        bgOverlay: "rgba(0,0,0,0.6)",
        textPrimary: "#e5e5e5",
        textSecondary: "#b0b0b0",
        textTertiary: "#808080",
        textMuted: "#585858",
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
        accentPurple: "#a855f7",
        accentCyan: "#06b6d4",
        link: "#60a5fa",
        linkHover: "#93bbfd",
        shadowCard: "rgba(0,0,0,0.4)"
    )

    /// LIGHT palette — bg/text/border lifted from the PWA `index.css
    /// [data-theme="light"]` block. Accents are DARKENED from the dark values to meet
    /// WCAG AA on the white background (Cluster 3): pure green/amber/cyan/orange on
    /// `#ffffff` fail 3:1, and `textFaint #d0d0d0` was ~1.5:1 (near-invisible). The
    /// darkened hues (Tailwind 600/700 family) stay recognizable — green reads green,
    /// red reads red — while clearing 4.5:1 as chip/status text. The semantic status
    /// accents (`statusActive` etc.) alias these, so every status dot / chip / badge /
    /// pill / banner is fixed at once. DARK is a separate literal → untouched.
    /// `borderSubtle` is the PWA's `rgba(0,0,0,0.06)`; `Color(hex:)` parses that form.
    public static let light = ThemePalette(
        bgPrimary: "#ffffff",
        bgSecondary: "#fafafa",
        bgTertiary: "#f0f0f0",
        bgSurface: "#e0e0e0",
        bgHover: "rgba(0,0,0,0.04)",
        bgSelected: "#e8e8e8",
        bgCode: "#f5f5f5",
        bgOverlay: "rgba(0,0,0,0.3)",
        textPrimary: "#1a1a1a",   // 17.4:1
        textSecondary: "#444444", // 9.7:1
        textTertiary: "#777777",  // 4.48:1
        textMuted: "#aaaaaa",     // legacy --text-muted (index.css [data-theme=light])
        textFaint: "#6b6b6b",     // 5.33:1 (was #d0d0d0 = 1.54:1 — the worst offender)
        borderPrimary: "#e0e0e0",
        borderSecondary: "#cccccc",
        borderSubtle: "rgba(0,0,0,0.06)",
        accentPrimary: "#2563eb", // blue-600, 5.17:1
        accentBlue: "#2563eb",    // blue-600 (was #3b82f6 = 3.68 → text-safe)
        accentGreen: "#15803d",   // green-700, 5.02:1 (was #22c55e = 2.28)
        accentRed: "#dc2626",     // red-600, 4.83:1 (was #ef4444 = 3.76)
        accentOrange: "#c2410c",  // orange-700, 5.18:1 (was #f97316 = 2.80)
        accentYellow: "#b45309",  // amber-700, 5.02:1 (was #eab308 = 1.92)
        accentPurple: "#9333ea",  // purple-600, 5.38:1 (was #a855f7 = 3.96)
        accentCyan: "#0e7490",    // cyan-700, 5.36:1 (was #06b6d4 = 2.43)
        link: "#2563eb",          // legacy --link (light)
        linkHover: "#1d4ed8",     // legacy --link-hover (light)
        shadowCard: "rgba(0,0,0,0.08)"
    )

    /// EDITORIAL-DARK — the DEFAULT skin (the hero). Warm espresso canvas, terracotta
    /// interactive accent (NOT blue), softened status hues. Every hex lifted own-hand
    /// from `index.css [data-skin="editorial"]` (:94–143). The interactive accent
    /// (`accentPrimary`/`accentBlue`/`link`) is terracotta `#cf6238`; the blue=
    /// interaction-only enforcement lands in BUILD-3 — here we just carry the values.
    /// `accentCyan` aliases the editorial fresh/unread hue `#5ba9a0` (`--status-fresh`)
    /// so `statusUnread` resolves correctly under editorial (the web keeps a separate
    /// `--status-*` set; the native palette folds them onto the accent fields the
    /// existing `status*` computed vars already read).
    public static let editorialDark = ThemePalette(
        bgPrimary: "#17120e",
        bgSecondary: "#1e1813",
        bgTertiary: "#251d16",
        bgSurface: "#2e251c",
        bgHover: "rgba(242,233,222,0.06)",
        bgSelected: "#2e251c",
        bgCode: "#1a130d",
        bgOverlay: "rgba(10,7,5,0.55)",
        textPrimary: "#f3ebe0",
        textSecondary: "#c9bbab",
        textTertiary: "#9b8b78",
        textMuted: "#897a67",
        textFaint: "#5a4d3f",
        borderPrimary: "#2c2219",
        borderSecondary: "#3a2f24",
        borderSubtle: "rgba(242,233,222,0.07)",
        accentPrimary: "#cf6238",  // terracotta (remaps blue UI accent)
        accentBlue: "#cf6238",     // terracotta — no blue interactive accent under editorial
        accentGreen: "#7fae5a",    // status live
        accentRed: "#d65440",      // status error
        accentOrange: "#d98a3e",
        accentYellow: "#e0a23c",   // status wait/streaming
        accentPurple: "#b283d6",   // status think/ask_user
        accentCyan: "#5ba9a0",     // status fresh/unread (--status-fresh)
        link: "#cf6238",
        linkHover: "#e6926a",
        shadowCard: "rgba(0,0,0,0.5)"
    )

    /// EDITORIAL-LIGHT — the warm-paper alternate (NOT cold white). Every hex lifted
    /// own-hand from `index.css [data-skin="editorial"][data-theme="light"]` (:146–189).
    /// Terracotta is deepened (`#bb5630`) for contrast on paper; status hues darkened
    /// to match. Same accent→status folding as editorial-dark.
    public static let editorialLight = ThemePalette(
        bgPrimary: "#f4ece1",
        bgSecondary: "#efe5d7",
        bgTertiary: "#fbf5ec",
        bgSurface: "#ffffff",
        bgHover: "rgba(40,28,16,0.05)",
        bgSelected: "#f3e8d8",
        bgCode: "#f0e6d6",
        bgOverlay: "rgba(60,40,20,0.35)",
        textPrimary: "#2a211a",
        textSecondary: "#5e5042",
        textTertiary: "#80715e",
        textMuted: "#927f69",
        textFaint: "#b6a48c",
        borderPrimary: "#e2d4c2",
        borderSecondary: "#d8c7b1",
        borderSubtle: "rgba(40,28,16,0.08)",
        accentPrimary: "#bb5630",  // deepened terracotta for paper contrast
        accentBlue: "#bb5630",
        accentGreen: "#5f8c3e",
        accentRed: "#bb4329",
        accentOrange: "#b5701f",
        accentYellow: "#bf7d1d",
        accentPurple: "#8a52bd",
        accentCyan: "#3f8079",     // --status-fresh (light)
        link: "#bb5630",
        linkHover: "#8f3f20",
        shadowCard: "rgba(70,45,20,0.12)"
    )

    /// The ONE semantic hue a session-list card carries on its rail + dot + status
    /// text — the editorial status-as-color language from the PWA
    /// (`deriveRailBgColor` precedence). Ended wins first (a finished card stays
    /// muted even if it errored); then error → red, working (streaming) → amber,
    /// alive (active/idle) → green; unknown falls back to muted. Native
    /// `DashboardSession` has no `resuming` field (PWA-only), so "working" keys off
    /// `status == "streaming"`.
    public static func sessionAccent(_ session: DashboardSession, hasError: Bool = false,
                                     _ p: ThemePalette = dark) -> String {
        if session.status == "ended" { return p.statusEnded }
        if hasError { return p.statusError }
        if session.status == "streaming" { return p.statusWorking }
        if session.status == "active" || session.status == "idle" { return p.statusActive }
        return p.statusEnded
    }

    /// Which animated state-pulse a card shows. Precedence mirrors the PWA
    /// `getCardPulseClass` EXACTLY: `currentTool == "ask_user"` (needs YOU) →
    /// `.needsInput`; else `status == "streaming"` (working) → `.working`; else
    /// `unread` → `.unread`; else `.none`. Ended sessions never pulse (they are
    /// neither streaming nor ask_user; unread on an ended card is intentional — the
    /// PWA shows the same cyan "fresh activity" tint).
    public static func cardPulseKind(_ session: DashboardSession) -> CardPulseKind {
        if session.currentTool == "ask_user" { return .needsInput }
        if session.status == "streaming" { return .working }
        if session.unread == true { return .unread }
        return .none
    }

    /// Tint hue for a pulse kind (purple/amber/cyan). `.none` → nil (no overlay).
    public static func pulseAccent(_ kind: CardPulseKind, _ p: ThemePalette = dark) -> String? {
        switch kind {
        case .needsInput: return p.statusNeedsInput
        case .working: return p.statusWorking
        case .unread: return p.statusUnread
        case .none: return nil
        }
    }
}
