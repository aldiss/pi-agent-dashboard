import Foundation

/// Pure, UI-free stat/format helpers for the session-card richness (parity B4).
/// These are the deterministic bits the card renders — elapsed time, cost, compact
/// token counts, command truncation — pinned by `swift test` so the display logic is
/// verified without a simulator. The SwiftUI layer only lays them out.
public enum StatsFormat {

    /// Human elapsed from a millisecond duration. Mirrors the PWA `formatElapsed`
    /// in `ProcessList.tsx` EXACTLY: `<60s → "Ns"`, `<60m → "Nm SSs"`, else
    /// `"Nh MMm"` (minute/second zero-padded to 2). Negatives clamp to 0.
    public static func elapsed(_ ms: Double) -> String {
        let totalSeconds = Int(max(0, ms) / 1000)
        if totalSeconds < 60 { return "\(totalSeconds)s" }
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        if minutes < 60 { return "\(minutes)m \(String(format: "%02d", seconds))s" }
        let hours = minutes / 60
        let remainMinutes = minutes % 60
        return "\(hours)h \(String(format: "%02d", remainMinutes))m"
    }

    /// Dollar cost label ("$1.23"), or nil when cost is nil / ≤ 0 (card hides it).
    /// Two decimals, matching the PWA `session.cost.toFixed(2)`.
    public static func cost(_ cost: Double?) -> String? {
        guard let cost, cost > 0 else { return nil }
        return "$" + String(format: "%.2f", cost)
    }

    /// Compact token count: `<1000 → "947"`, `<1e6 → "12.3k"`, else `"1.2M"`.
    /// nil / ≤ 0 → nil. For the card's tokens chip (in+out).
    public static func tokensCompact(_ tokens: Double?) -> String? {
        guard let tokens, tokens > 0 else { return nil }
        switch tokens {
        case ..<1000: return "\(Int(tokens))"
        case ..<1_000_000: return String(format: "%.1fk", tokens / 1000)
        default: return String(format: "%.1fM", tokens / 1_000_000)
        }
    }

    /// Sum of in+out tokens as a compact label, or nil when both are absent/zero.
    public static func totalTokensCompact(in tokensIn: Double?, out tokensOut: Double?) -> String? {
        let total = (tokensIn ?? 0) + (tokensOut ?? 0)
        return tokensCompact(total)
    }

    /// Truncate a process command to `maxLen` with a trailing ellipsis. Mirrors the
    /// PWA `truncateCommand` (default 40; the compact card row uses 30).
    public static func truncateCommand(_ command: String, maxLen: Int = 40) -> String {
        if command.count <= maxLen { return command }
        return String(command.prefix(maxLen - 1)) + "…"
    }
}
