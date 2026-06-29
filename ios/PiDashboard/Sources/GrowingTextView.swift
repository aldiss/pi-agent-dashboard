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

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextView {
        let tv = UITextView()
        tv.delegate = context.coordinator
        tv.backgroundColor = .clear
        tv.font = .systemFont(ofSize: 16)
        tv.textColor = UIColor(white: 0.9, alpha: 1) // ≈ textPrimary #e5e5e5
        tv.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
        tv.textContainer.lineFragmentPadding = 0
        tv.isScrollEnabled = true
        tv.keyboardAppearance = .dark
        tv.returnKeyType = .default // Enter = newline
        tv.autocorrectionType = .yes
        tv.accessibilityIdentifier = "mobile-composer-textarea"
        // Placeholder
        let ph = UILabel()
        ph.text = "Message"
        ph.font = .systemFont(ofSize: 16)
        ph.textColor = UIColor(white: 0.5, alpha: 1) // ≈ textTertiary
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
