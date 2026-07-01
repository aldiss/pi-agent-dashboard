import SwiftUI
import UIKit

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
        if tv.text != text { tv.text = text }
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
        context.coordinator.placeholder?.isHidden = !text.isEmpty
        recalcHeight(tv)
    }

    private func recalcHeight(_ tv: UITextView) {
        let width = tv.bounds.width > 0 ? tv.bounds.width : UIScreen.main.bounds.width - 120
        let size = tv.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let clamped = min(max(minHeight, size.height), maxHeight)
        DispatchQueue.main.async { onHeightChange(size.height) }
        tv.isScrollEnabled = size.height > maxHeight
        _ = clamped
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: GrowingTextView
        weak var placeholder: UILabel?
        init(_ parent: GrowingTextView) { self.parent = parent }

        func textViewDidChange(_ tv: UITextView) {
            parent.text = tv.text
            placeholder?.isHidden = !tv.text.isEmpty
            let width = tv.bounds.width > 0 ? tv.bounds.width : UIScreen.main.bounds.width - 120
            let size = tv.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
            parent.onHeightChange(size.height)
            tv.isScrollEnabled = size.height > parent.maxHeight
        }
    }
}
