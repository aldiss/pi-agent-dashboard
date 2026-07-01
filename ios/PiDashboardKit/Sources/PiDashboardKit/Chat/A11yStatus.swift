import Foundation

/// Non-color status cue for VoiceOver (Cluster 5). A green/amber/red/gray dot is
/// meaningless to a screen-reader user (color-only), so the status is ALSO spoken as
/// a human word. Single-sources the mapping raw `status` (+ tool/error context) → a
/// spoken label, mirroring the visual semantic-accent precedence (error > ended >
/// waiting-for-ask > working > idle). Pure → `swift test`-able.
public enum A11yStatus {
    /// Spoken status for VoiceOver. Precedence matches the card's visual meaning:
    ///   hasError → "Error" · ended → "Ended" · currentTool == "ask_user" → "Waiting
    ///   for your input" · streaming → "Working" · active/idle → "Idle" · else the raw
    ///   status (capitalized) or "Unknown".
    public static func statusLabel(_ status: String?, currentTool: String? = nil,
                                   hasError: Bool = false) -> String {
        if hasError { return "Error" }
        if status == "ended" { return "Ended" }
        if currentTool == "ask_user" { return "Waiting for your input" }
        switch status {
        case "streaming":       return "Working"
        case "active", "idle":  return "Idle"
        case .some(let s) where !s.isEmpty: return s.prefix(1).uppercased() + s.dropFirst()
        default:                return "Unknown"
        }
    }
}

/// Motion policy for VoiceOver / Reduce Motion (Cluster 5). Gates the card
/// state-pulses + the mic recording ring so nothing loops when the user asked the OS
/// to reduce motion. Pure decision helper the views call with
/// `@Environment(\.accessibilityReduceMotion)`.
public enum A11yMotion {
    /// Whether looping/pulsing animations may run. `false` when Reduce Motion is on —
    /// the view then shows a static state instead of an infinite animation.
    public static func pulsesEnabled(reduceMotion: Bool) -> Bool { !reduceMotion }
}
