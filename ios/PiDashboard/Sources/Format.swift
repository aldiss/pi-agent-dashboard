import Foundation
import PiDashboardKit

/// Small pure formatters the cards/chat share. Kept in the app target (UI-adjacent
/// presentation, not protocol logic — the core stays UI-free).
enum Format {
    /// Compact relative age from an epoch-ms timestamp: "now" / "30s" / "5m" / "2h" / "3d".
    static func relativeAge(fromEpochMs ms: Double?, now: Date = Date()) -> String {
        guard let ms, ms > 0 else { return "" }
        let seconds = max(0, now.timeIntervalSince1970 - ms / 1000)
        switch seconds {
        case ..<5: return "now"
        case ..<60: return "\(Int(seconds))s"
        case ..<3600: return "\(Int(seconds / 60))m"
        case ..<86400: return "\(Int(seconds / 3600))h"
        default: return "\(Int(seconds / 86400))d"
        }
    }

    /// Context window usage as a whole percent string ("42%"), or nil when unknown.
    static func contextPercent(_ session: DashboardSession) -> String? {
        guard let frac = session.contextFraction else { return nil }
        return "\(Int((frac * 100).rounded()))%"
    }

    /// Model label trimmed to the id after `provider/` ("claude-opus-4"), + thinking.
    static func modelLabel(_ session: DashboardSession) -> String? {
        guard let model = session.model, !model.isEmpty else { return nil }
        let short = model.split(separator: "/").last.map(String.init) ?? model
        if let thinking = session.thinkingLevel, !thinking.isEmpty {
            return "\(short) · \(thinking)"
        }
        return short
    }

    /// Short label for the next-engagement effort badge.
    static func engagementLabel(_ effort: String) -> String {
        switch effort {
        case "autonomous": return "autonomous"
        case "one-action": return "1 action"
        case "short": return "short"
        case "back-and-forth": return "back & forth"
        default: return effort
        }
    }
}
