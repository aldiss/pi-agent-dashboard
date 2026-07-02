import Foundation

/// Pure time formatting for chat message rows. UI-free + deterministic (timezone +
/// locale injectable) so `clockTime` is pinned by `swift test`; the app target's
/// `Format.clockTime` is a thin pass-through using the device timezone/locale.
public enum TimeFormat {

    /// 24-hour wall-clock `HH:mm` for an epoch-ms timestamp, in the given timezone.
    /// Fixed `HH:mm` pattern + POSIX locale → always 24h regardless of the device's
    /// region 12/24h setting (operator wants a stable timestamp), but rendered in the
    /// device's local timezone. Empty string for a missing/nonpositive timestamp.
    public static func clockTime(fromEpochMs ms: Double,
                                 timeZone: TimeZone = .current) -> String {
        guard ms > 0 else { return "" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "HH:mm"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    /// Short day label `d MMM` (e.g. "30 Jun") for an epoch-ms timestamp — shown as a
    /// divider when a message falls on a different calendar day than the prior one.
    public static func shortDate(fromEpochMs ms: Double,
                                 timeZone: TimeZone = .current,
                                 locale: Locale = .current) -> String {
        guard ms > 0 else { return "" }
        let f = DateFormatter()
        f.locale = locale
        f.timeZone = timeZone
        f.setLocalizedDateFormatFromTemplate("d MMM")
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    /// True when two epoch-ms timestamps fall on different calendar days (in `timeZone`).
    /// Drives the optional day-divider. A zero/absent prior timestamp → false (no divider).
    public static func isNewDay(_ ms: Double, since prior: Double,
                                timeZone: TimeZone = .current) -> Bool {
        guard ms > 0, prior > 0 else { return false }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        return !cal.isDate(Date(timeIntervalSince1970: ms / 1000),
                           inSameDayAs: Date(timeIntervalSince1970: prior / 1000))
    }

    /// Elapsed `M:SS` (seconds zero-padded) between a start and `now`, both epoch-ms —
    /// the working-state "thinking… 0:45" / "running bash… 0:12" timer that tells alive
    /// from hung. Minutes are NOT zero-padded and roll past 60 ("61:01" for 61 min).
    /// A nonpositive start, or `now <= start` (clock skew / not-yet-started), → "0:00".
    public static func elapsedClock(fromEpochMs start: Double, now: Double) -> String {
        guard start > 0, now > start else { return "0:00" }
        let totalSeconds = Int((now - start) / 1000)
        return "\(totalSeconds / 60):\(String(format: "%02d", totalSeconds % 60))"
    }

    /// Upper bound on a *plausible* single agent-run elapsed time (6 h in ms). A working
    /// row anchored further back than this is almost certainly a stale/garbage start
    /// (e.g. a session already streaming when the app opens, before a fresh
    /// `turn_start`/`agent_start` resets the anchor) — NOT a genuinely 6-hour turn.
    public static let maxPlausibleElapsedMs: Double = 6 * 60 * 60 * 1000

    /// Guarded elapsed clock: same `M:SS` as `elapsedClock`, but returns `nil` (instead of
    /// a value) whenever the start is untrustworthy — missing/nonpositive, `now <= start`
    /// (clock skew), or so far in the past that the delta exceeds `maxPlausibleElapsedMs`.
    /// The working-state row uses this so a bogus anchor renders just "thinking…" /
    /// "running <tool>…" with NO garbage timer (the `45637:13` bug), never a fake H:MM.
    public static func elapsedClockOrNil(fromEpochMs start: Double, now: Double) -> String? {
        guard start > 0, now > start, (now - start) <= maxPlausibleElapsedMs else { return nil }
        return elapsedClock(fromEpochMs: start, now: now)
    }

    /// Optional-start convenience for the SwiftUI call site (`state.streamingStartedAt` is
    /// `Double?`). `nil` start → `nil` (suppress), otherwise delegates to the guard above.
    public static func elapsedClockOrNil(fromEpochMs start: Double?, now: Double) -> String? {
        guard let start else { return nil }
        return elapsedClockOrNil(fromEpochMs: start, now: now)
    }
}
