import SwiftUI
import UIKit
import PiDashboardKit

/// The app's motion vocabulary — a thin SwiftUI mapper over the Kit's pure
/// `SpringSpec` numbers (engine-b §2d / §4.2). The exact spring math is pinned by
/// `swift test` in the Kit; this layer only turns a `SpringSpec` into an `Animation`
/// and applies the ONE reduce-motion policy (`A11yMotion`, the reconciled source of
/// truth — no second reduce-motion opinion lives here).
///
/// Deliberately NO bouncy feel: every wired token is critically- or over-damped.
/// **Never** use Apple's `.snappy` / `.bouncy` — they carry overshoot (taste
/// violation) and name-collide with our `snappy` token.
enum Motion {
    /// Build a SwiftUI spring from a Kit `SpringSpec`. Custom spring (not an Apple
    /// preset) so the no-bounce dampingFraction is honored exactly.
    static func spring(_ spec: SpringSpec) -> Animation {
        .spring(response: spec.response, dampingFraction: spec.dampingFraction)
    }

    /// PRIMARY, no-bounce (web 400/42). Press-back, card settle, scroll-to-bottom,
    /// most transitions.
    static let smooth = spring(.smooth)

    /// Large/soft, no-bounce (web 240/30). Sheet enter, group collapse, root crossfade.
    static let gentle = spring(.gentle)

    /// GUARDED — the under-damped token (web 520/34). Defined but UNWIRED until an
    /// operator no-bounce feel-confirm (`SpringSpec.snappy.isGuarded == true`). Present
    /// so the value is one edit from shipping; do not route transitions through it yet.
    static let snappy = spring(.snappy)

    /// The reduce-motion TRAVEL gate for one-shot animations, delegating to the single
    /// Kit policy: `A11yMotion.travelEnabled`. Returns the spring when motion is
    /// allowed, else `nil` — pass straight to `.animation(Motion.animation(.smooth,
    /// reduceMotion: rm), value:)` / `withAnimation(Motion.animation(...))` so the
    /// change applies instantly under Reduce Motion. (Haptics are NOT gated here — they
    /// bypass by design; see `A11yMotion.hapticsAllowed`.)
    static func animation(_ spring: Animation, reduceMotion: Bool) -> Animation? {
        A11yMotion.travelEnabled(reduceMotion: reduceMotion) ? spring : nil
    }
}

/// One persistent, `.prepare()`d haptic surface for the MODEL layer (non-View call
/// sites like `VoiceRecorder`, where the `.sensoryFeedback` view modifier cannot
/// attach). View code should prefer `.sensoryFeedback` directly; this exists so the
/// four throwaway `UINotificationFeedbackGenerator()` allocations become one warmed
/// generator (lower latency, no per-call alloc). Haptics BYPASS the reduce-motion gate
/// (a tactile tick is an a11y aid), so there is no `reduceMotion` parameter here.
@MainActor
enum Haptics {
    private static let notifier: UINotificationFeedbackGenerator = {
        let g = UINotificationFeedbackGenerator()
        g.prepare()
        return g
    }()

    /// Success tick — a committed action landed (message sent, recording started).
    static func success() {
        notifier.notificationOccurred(.success)
        notifier.prepare() // re-warm for the next fire
    }

    /// Warning tick — an action was interrupted/stopped (stream stop, recording end).
    static func warning() {
        notifier.notificationOccurred(.warning)
        notifier.prepare()
    }
}

/// The app's tappable-surface feel: a subtle press-in scale on `Motion.smooth` plus a
/// `.selection` haptic tick on the down edge — the per-press feedback that was the big
/// gap (inert `.buttonStyle(.plain)` sites had neither). Reconciled with the ONE
/// reduce-motion policy: under Reduce Motion the scale is suppressed (stays 1), but the
/// haptic STILL fires (haptics bypass the gate — `A11yMotion.hapticsAllowed`). Disabled
/// controls get neither scale nor tick.
///
/// Two sizes: default `0.97` for buttons/chips; `0.985` for whole-card surfaces (a big
/// card needs a smaller ratio to read as the same physical press). Use `.pressable` /
/// `.pressableCard`.
struct PressableStyle: ButtonStyle {
    var pressScale: CGFloat = 0.97
    /// Whole-card press ratio — gentler because the surface is large.
    static let cardScale: CGFloat = 0.985

    func makeBody(configuration: Configuration) -> some View {
        PressableBody(configuration: configuration, pressScale: pressScale)
    }

    /// Nested `View` so it can read `@Environment` (a `ButtonStyle` itself cannot). One
    /// `@Environment(\.accessibilityReduceMotion)` read — the same policy flag every
    /// other motion site uses — keeps the reduce-motion decision single-sourced.
    private struct PressableBody: View {
        let configuration: ButtonStyleConfiguration
        let pressScale: CGFloat
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            let pressed = configuration.isPressed
            // Disabled or Reduce Motion → no travel (scale stays 1); else press-in.
            let scale = (isEnabled && !reduceMotion && pressed) ? pressScale : 1
            configuration.label
                .scaleEffect(scale)
                .animation(Motion.animation(Motion.smooth, reduceMotion: reduceMotion), value: pressed)
                // Down edge only (old == false, new == true), and only when enabled.
                // Not gated on reduceMotion — the tick is an a11y aid that bypasses it.
                .sensoryFeedback(trigger: pressed) { old, new in
                    (isEnabled && !old && new) ? .selection : nil
                }
        }
    }
}

extension ButtonStyle where Self == PressableStyle {
    /// Default tappable feel (buttons, chips, headers): press-in `0.97` + selection tick.
    static var pressable: PressableStyle { PressableStyle() }
    /// Whole-card feel: gentler press-in `0.985` + selection tick.
    static var pressableCard: PressableStyle { PressableStyle(pressScale: PressableStyle.cardScale) }
}
