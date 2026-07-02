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

/// A `UITextView` bridged to SwiftUI that auto-sizes and reports its intrinsic
/// content height. Enter inserts a newline (NEVER sends) — mobile-composer contract.
/// The reported height feeds `ComposerLayout.isMultiline` / `clampedHeight` so the
/// single-row⇄column flip uses the SAME core rule the unit tests pin.
struct GrowingTextView: UIViewRepresentable {
    @Binding var text: String
    let minHeight: CGFloat
    let maxHeight: CGFloat
    /// Called with the measured intrinsic content height on every change.
    let onHeightChange: (CGFloat) -> Void
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

    /// Composer input font — size 17 to match the rest of the app's composer UI
    /// (`AdaptiveComposer`), so the typed text reads as the same font.
    private static let inputFont = UIFont.systemFont(ofSize: 17)

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextView {
        let tv = UITextView()
        tv.delegate = context.coordinator
        tv.backgroundColor = .clear
        tv.font = Self.inputFont
        tv.textColor = UIColor(textColor)
        tv.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
        tv.textContainer.lineFragmentPadding = 0
        tv.isScrollEnabled = true
        tv.keyboardAppearance = keyboardAppearance
        tv.returnKeyType = .default // Enter = newline
        tv.autocorrectionType = .yes
        tv.accessibilityIdentifier = "mobile-composer-textarea"
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

    func updateUIView(_ tv: UITextView, context: Context) {
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
        DispatchQueue.main.async { onHeightChange(size.height) }
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
            parent.onHeightChange(size.height)
            tv.isScrollEnabled = size.height > parent.maxHeight
        }
    }
}
