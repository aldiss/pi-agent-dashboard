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

/// Motion policy for VoiceOver / Reduce Motion — the ONE reduce-motion source of
/// truth for the app (Cluster 5 pulse-gate + BUILD-2 travel-gate + haptic policy,
/// reconciled). Pure decision helpers the views call with a single
/// `@Environment(\.accessibilityReduceMotion)` read, so the app never grows a second,
/// diverging reduce-motion opinion. Two distinct gates by design:
///   - PULSE gate (`pulsesEnabled`) — may an infinite looping/breathing animation run?
///   - TRAVEL gate (`travelEnabled`) — may a one-shot transition/press spring travel?
/// They compose (both keyed off the same flag) but stay named so a caller states which
/// kind of motion it means. Haptics deliberately BYPASS both (see `hapticsAllowed`).
public enum A11yMotion {
    /// Whether looping/pulsing animations may run (the card breathe, the mic ring).
    /// `false` when Reduce Motion is on — the view shows a static state instead.
    public static func pulsesEnabled(reduceMotion: Bool) -> Bool { !reduceMotion }

    /// Whether a one-shot TRAVEL animation (press-back, card settle, expand, sheet
    /// enter, crossfade) may play. `false` under Reduce Motion → the change is applied
    /// instantly with no spring. The app-layer `Motion.animation(_:reduceMotion:)`
    /// delegates here so the `spring-or-nil` decision lives in exactly one place.
    public static func travelEnabled(reduceMotion: Bool) -> Bool { !reduceMotion }

    /// Whether a haptic tick may fire. ALWAYS `true` — haptics intentionally bypass the
    /// reduce-motion gate: a tactile confirmation is an accessibility AID (it does not
    /// move pixels), so it stays available even when the user reduces on-screen motion.
    public static func hapticsAllowed(reduceMotion: Bool) -> Bool { true }
}

/// A UI-free spring specification — `response` (seconds) + `dampingFraction` (0…≥1),
/// the two params SwiftUI's `.spring(response:dampingFraction:)` takes. Kept in the
/// Kit (not the app) as PLAIN NUMBERS so `swift test` pins the exact spring math
/// without importing SwiftUI; the app-layer `Motion` maps these to `Animation`.
///
/// Ported from the web `motion/springs.ts` `{stiffness, damping}` (mass = 1) via
///   `response = 2π/√stiffness`, `dampingFraction = damping/(2√stiffness)`.
/// The named tokens are the design vocabulary (engine-b §2d / §4.2):
///   - `smooth` (web 400/42) — the PRIMARY: press-back, card settle, most transitions.
///     Raw dampingFraction ≈ 1.05 (over-damped) is CLAMPED to 1.0 (no overshoot).
///   - `gentle` (web 240/30) — large/soft: sheet enter, group collapse, root crossfade.
///   - `snappy` (web 520/34) — the ONE under-damped token (≈0.75). GUARDED: defined but
///     `isGuarded == true`, left UNWIRED until an operator no-bounce feel-confirm. Never
///     substitute Apple's `.snappy`/`.bouncy` (they carry bounce — taste + name clash).
public struct SpringSpec: Sendable, Equatable {
    public let response: Double
    public let dampingFraction: Double
    /// `true` for tokens withheld from wiring pending sign-off (only `snappy`). A guard
    /// flag rather than omission so the value is testable + one edit away from shipping.
    public let isGuarded: Bool

    public init(response: Double, dampingFraction: Double, isGuarded: Bool = false) {
        self.response = response
        self.dampingFraction = dampingFraction
        self.isGuarded = isGuarded
    }

    /// PRIMARY, no-bounce. web 400/42 → response 0.31, dampingFraction clamped 1.0.
    public static let smooth = SpringSpec(response: 0.31, dampingFraction: 1.0)
    /// Large/soft, no-bounce. web 240/30 → response 0.41, dampingFraction 0.97.
    public static let gentle = SpringSpec(response: 0.41, dampingFraction: 0.97)
    /// GUARDED under-damped token. web 520/34 → response 0.28, dampingFraction 0.75.
    /// Unwired until sign-off (`isGuarded`); never map to Apple's bouncy springs.
    public static let snappy = SpringSpec(response: 0.28, dampingFraction: 0.75, isGuarded: true)
}
