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
}
