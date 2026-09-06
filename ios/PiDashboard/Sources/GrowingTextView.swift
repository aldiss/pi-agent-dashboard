import SwiftUI
import UIKit
import PiDashboardKit

/// A one-shot signal the composer flips to mark the NEXT `text` binding change as a
/// PROGRAMMATIC edit (send → "", voice-append) rather than a user keystroke. A
/// reference type so `GrowingTextView` (a value-type `UIViewRepresentable`) and the
/// owning `AdaptiveComposer` observe the same flag across re-renders. `updateUIView`
/// consumes (resets) it after applying, so it only ever forces a single push.
final class ComposerTextSignal {
    var programmatic = false
    /// Mark the next binding push as programmatic (call BEFORE mutating the bound text).
    func markProgrammatic() { programmatic = true }
}

/// A `UITextView` subclass that gives an EXTERNAL keyboard's Return key a send action
/// while leaving the on-screen keyboard's Return exactly as it was.
///
/// `keyCommands` fire for HARDWARE keyboards only, so a soft-keyboard Return never
/// reaches this path and keeps inserting a newline. Shift+Return is deliberately NOT
/// registered, so UIKit handles it natively as a newline — the operator's contract is
/// "Enter sends, Shift+Enter newlines", and the cheapest way to honour the second half
/// is to not intercept it.
///
/// `wantsPriorityOverSystemBehavior` is required: the text view is first responder and
/// would otherwise consume Return as text input before the command is offered.
///
/// UNVERIFIED AT AUTHORING: that the soft keyboard is untouched rests on documented
/// `UIKeyCommand` behaviour, not on a run — the machine was under a memory hold barring
/// builds and simulators. Device-gated.
final class ComposerTextView: UITextView {
    /// Called with `hasShift`; returns true when the composer CONSUMED the key (sent).
    /// Returning false means "insert a newline", which this view must then do itself —
    /// a consumed key command suppresses UIKit's default insertion, so doing nothing
    /// would silently swallow the keystroke.
    var onHardwareReturn: ((Bool) -> Bool)?

    override var keyCommands: [UIKeyCommand]? {
        let cmd = UIKeyCommand(input: "\r", modifierFlags: [],
                               action: #selector(handleHardwareReturn))
        cmd.wantsPriorityOverSystemBehavior = true
        return [cmd]
    }

    @objc private func handleHardwareReturn() {
        // Shift+Return is not registered above, so it never arrives here; pass false.
        let consumed = onHardwareReturn?(false) ?? false
        if !consumed { insertText("\n") }
    }

    /// Keyboard accessory carrying ONE control: Done, which ends editing and does
    /// nothing else. There is deliberately no second keyboard-state model — dismissal
    /// IS `resignFirstResponder`, so the draft text and any attached images are
    /// untouched by construction and survive dismiss/refocus with no save-restore path
    /// to get wrong. It sends nothing and queues nothing.
    ///
    /// Standard `UIToolbar` height is 44pt, which is the minimum tap target, and the
    /// item is right-aligned where iOS users expect Done to sit.
    func installDismissAccessory(keyboardAppearance: UIKeyboardAppearance) {
        let bar = UIToolbar()
        bar.barStyle = (keyboardAppearance == .dark) ? .black : .default
        let done = UIBarButtonItem(title: "Done", style: .done,
                                   target: self, action: #selector(dismissKeyboardTapped))
        done.accessibilityLabel = "Dismiss keyboard"
        done.accessibilityIdentifier = "mobile-composer-dismiss-keyboard"
        bar.items = [UIBarButtonItem(barButtonSystemItem: .flexibleSpace,
                                     target: nil, action: nil), done]
        bar.sizeToFit()
        inputAccessoryView = bar
    }

    /// Re-style an already-installed accessory when the app's theme flips, without
    /// rebuilding it (a rebuild mid-edit would reload input views unnecessarily).
    func restyleDismissAccessory(keyboardAppearance: UIKeyboardAppearance) {
        (inputAccessoryView as? UIToolbar)?.barStyle =
            (keyboardAppearance == .dark) ? .black : .default
    }

    @objc private func dismissKeyboardTapped() {
        // Dismiss ONLY. No send, no draft mutation, no focus bookkeeping beyond
        // ending first responder.
        resignFirstResponder()
    }
}

/// A `UITextView` bridged to SwiftUI that auto-sizes and reports its intrinsic
/// content height. The ON-SCREEN keyboard's Enter inserts a newline (never sends) —
/// mobile-composer contract. An EXTERNAL keyboard's unmodified Enter sends, and
/// Shift+Enter still inserts a newline; that decision is `ComposerLayout.returnKeyAction`
/// and the wiring is `ComposerTextView` above.
/// The reported height feeds `ComposerLayout.isMultiline` / `clampedHeight` so the
/// single-row⇄column flip uses the SAME core rule the unit tests pin.
struct GrowingTextView: UIViewRepresentable {
    @Binding var text: String
    let minHeight: CGFloat
    let maxHeight: CGFloat
    /// Called with intrinsic height plus the exact text measured. The text provenance lets
    /// the composer discard an older async measurement after a programmatic binding update.
    let onHeightChange: (CGFloat, String) -> Void
    var isEnabled: Bool = true
    /// Marks a binding change as programmatic so `updateUIView` force-applies it even
    /// while the field is first responder (send-clear / voice-append), without ever
    /// clobbering the user's own in-flight typing on a lagging streaming re-render.
    var signal: ComposerTextSignal
    /// Theme-aware colors + keyboard, threaded from the composer so the input tracks
    /// the app's ThemeController (NOT the OS trait). Re-applied in `updateUIView` so a
    /// live theme switch re-colors the composer text, placeholder, and keyboard.
    var textColor: Color = .primary
    var placeholderColor: Color = .secondary
    var keyboardAppearance: UIKeyboardAppearance = .default

    /// Hardware-Return handler, supplied by the composer (which owns the text, image and
    /// in-flight state the decision needs). Returns true when it sent. Re-assigned on
    /// every `updateUIView` so it can never capture a stale composer snapshot.
    var onHardwareReturn: ((Bool) -> Bool)? = nil

    /// Composer input font — size 17 to match the rest of the app's composer UI
    /// (`AdaptiveComposer`), so the typed text reads as the same font.
    private static let inputFont = UIFont.systemFont(ofSize: 17)

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> ComposerTextView {
        let tv = ComposerTextView()
        tv.delegate = context.coordinator
        tv.backgroundColor = .clear
        tv.font = Self.inputFont
        tv.textColor = UIColor(textColor)
        tv.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
        tv.textContainer.lineFragmentPadding = 0
        // WRAP a long line to the field width instead of overflowing horizontally.
        // widthTracksTextView pins the text container to the view width; byWordWrapping
        // makes the layout manager break long lines. Together with the low horizontal
        // hugging/compression priorities + sizeThatFits(...) below, SwiftUI constrains
        // the width (never the huge intrinsic width) so a long dictated line grows into
        // MULTILINE and never runs off-screen (operator: "строка вылезает за пределы").
        tv.textContainer.widthTracksTextView = true
        tv.textContainer.lineBreakMode = .byWordWrapping
        tv.setContentHuggingPriority(.defaultLow, for: .horizontal)
        tv.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        tv.isScrollEnabled = true
        tv.keyboardAppearance = keyboardAppearance
        tv.returnKeyType = .default // Enter = newline (soft keyboard; see ComposerTextView)
        tv.autocorrectionType = .yes
        tv.accessibilityIdentifier = "mobile-composer-textarea"
        tv.installDismissAccessory(keyboardAppearance: keyboardAppearance)
        // Placeholder
        let ph = UILabel()
        ph.text = "Message"
        ph.font = Self.inputFont
        ph.textColor = UIColor(placeholderColor)
        ph.tag = 99
        ph.translatesAutoresizingMaskIntoConstraints = false
        tv.addSubview(ph)
        NSLayoutConstraint.activate([
            ph.leadingAnchor.constraint(equalTo: tv.leadingAnchor, constant: 0),
            ph.topAnchor.constraint(equalTo: tv.topAnchor, constant: 8),
        ])
        context.coordinator.placeholder = ph
        return tv
    }

    /// Return the height the text needs at SwiftUI's PROPOSED width (iOS 16+). This is
    /// the core overflow fix: by reporting a size for the proposed width, SwiftUI
    /// CONSTRAINS the field to that width instead of adopting the UITextView's (huge,
    /// unwrapped) intrinsic width — so a long single line WRAPS to the composer width
    /// and grows the height (which flips `isMultiline`) rather than running off both
    /// screen edges. Width is resolved via the pure `ComposerLayout.resolvedWrapWidth`
    /// (finite-positive proposal wins; else current bounds), height clamped to the band.
    /// Returns nil when no usable width is available yet (SwiftUI keeps the prior size).
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerTextView, context: Context) -> CGSize? {
        guard let width = ComposerLayout.resolvedWrapWidth(
            proposed: proposal.width.map(Double.init), current: Double(uiView.bounds.width))
        else { return nil }
        let fit = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let clamped = min(max(minHeight, fit.height), maxHeight)
        return CGSize(width: width, height: clamped)
    }

    func updateUIView(_ tv: ComposerTextView, context: Context) {
        // Re-bind every render: a closure captured once in makeUIView would hold a stale
        // composer snapshot (old text / image count / in-flight flag) and decide on it.
        tv.onHardwareReturn = onHardwareReturn
        // Push the bound value into the field ONLY for programmatic edits (send-clear,
        // voice-append) or an idle field — NEVER echo the user's own in-flight typing
        // back on a lagging streaming re-render (that dropped the character + caret).
        let isProgrammatic = signal.programmatic
        if ComposerLayout.shouldApplyBinding(fieldText: tv.text, boundText: text,
                                             isFirstResponder: tv.isFirstResponder,
                                             isProgrammatic: isProgrammatic) {
            let selected = tv.selectedRange
            tv.text = text
            // Preserve the caret across a legit programmatic update: clamp the prior
            // selection into the new length (clear → 0; append → stays put).
            let end = (text as NSString).length
            tv.selectedRange = NSRange(location: min(selected.location, end), length: 0)
            context.coordinator.placeholder?.isHidden = !text.isEmpty
        }
        if isProgrammatic { signal.programmatic = false } // consume — one-shot
        tv.isEditable = isEnabled
        // Re-apply theme-aware styling so a live theme switch (ThemeController) recolors
        // the composer without a remount. Cheap idempotent sets.
        tv.textColor = UIColor(textColor)
        tv.font = Self.inputFont
        if tv.keyboardAppearance != keyboardAppearance {
            tv.keyboardAppearance = keyboardAppearance
            tv.restyleDismissAccessory(keyboardAppearance: keyboardAppearance)
            // The keyboard only picks up a new appearance on the next edit session;
            // reload it in place if the field is currently first responder.
            if tv.isFirstResponder { tv.reloadInputViews() }
        }
        context.coordinator.placeholder?.textColor = UIColor(placeholderColor)
        context.coordinator.placeholder?.isHidden = !tv.text.isEmpty
        recalcHeight(tv)
    }

    /// Measure the intrinsic height and report it. Skips entirely when the field has
    /// no laid-out width (`bounds.width == 0` during a re-layout) — the old
    /// `UIScreen.main.bounds.width - 120` fallback yielded a WRONG width → a transient
    /// mis-measure that spuriously flipped `isMultiline` and tore the field down.
    private func recalcHeight(_ tv: UITextView) {
        guard tv.bounds.width > 0 else { return }
        let size = tv.sizeThatFits(CGSize(width: tv.bounds.width, height: .greatestFiniteMagnitude))
        // Report async: updateUIView runs inside SwiftUI's render pass; mutating the
        // composer's @State (measuredHeight) synchronously here is a same-cycle write.
        let measuredText = tv.text ?? ""
        DispatchQueue.main.async { onHeightChange(size.height, measuredText) }
        tv.isScrollEnabled = size.height > maxHeight
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: GrowingTextView
        weak var placeholder: UILabel?
        init(_ parent: GrowingTextView) { self.parent = parent }

        func textViewDidChange(_ tv: UITextView) {
            parent.text = tv.text
            placeholder?.isHidden = !tv.text.isEmpty
            // Measure SYNCHRONOUSLY on the real keystroke so `measuredHeight` is fresh
            // before the text-driven `.onChange(of: text)` recomputes `isMultiline`.
            // Skip when unlaid-out (width 0) — no wrong-width fallback.
            guard tv.bounds.width > 0 else { return }
            let size = tv.sizeThatFits(CGSize(width: tv.bounds.width, height: .greatestFiniteMagnitude))
            parent.onHeightChange(size.height, tv.text)
            tv.isScrollEnabled = size.height > parent.maxHeight
        }
    }
}
