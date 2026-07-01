import Foundation

/// Chat-view color language (color batch 2) — the pure, UI-free role→accent and
/// tool-status→accent mappers the native chat rows render off. Reuses the semantic
/// accents already in `ThemePalette` (color batch 1) so the whole app shares ONE
/// palette. Mirrors the PWA chat hues: tool running→amber, done→green, error→red
/// (`ToolCallStep.tsx`); thinking→purple (`ThinkingBlock.tsx`); user→blue.
public enum ChatColors {

    /// The subtle role accent a chat row carries (border rule / tint), or nil for a
    /// role that renders on the plain surface (assistant prose, separators).
    ///   user → blue · thinking → purple · toolResult → amber · bashOutput → green ·
    ///   commandFeedback/rawEvent → muted tertiary · assistant/turnSeparator → nil.
    public static func roleAccent(_ role: ChatRole, _ p: ThemePalette = DashboardTheme.dark) -> String? {
        switch role {
        case .user:            return p.accentBlue
        case .thinking:        return p.accentPurple
        case .toolResult:      return p.accentYellow
        case .bashOutput:      return p.accentGreen
        case .commandFeedback: return p.textTertiary
        case .rawEvent:        return p.textTertiary
        case .assistant, .turnSeparator: return nil
        }
    }

    /// Tool-call status hue for the header icon + leading rule. Mirrors
    /// `ToolCallStep.tsx`: running→amber, complete→green, error→red. `nil` status
    /// (no tool bookkeeping yet) → muted tertiary.
    public static func toolStatusAccent(_ status: ToolStatus?, _ p: ThemePalette = DashboardTheme.dark) -> String {
        switch status {
        case .running:  return p.accentYellow
        case .complete: return p.accentGreen
        case .error:    return p.accentRed
        case .none:     return p.textTertiary
        }
    }
}
