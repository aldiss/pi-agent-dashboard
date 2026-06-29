import SwiftUI
import PhotosUI
import PiDashboardKit

/// Native port of the PWA `MobileComposer`. The single-row⇄column flip, height
/// clamp, and send-gating ALL come from the core's `ComposerLayout` (the same rule
/// the unit tests pin) — this view only renders the two layouts over one stable
/// element tree. Identifiers + `accessibilityValue` single-row/multiline per
/// TEST-CONTRACT §A so the XCUITest can assert the hysteresis.
struct AdaptiveComposer: View {
    let isWorking: Bool
    let queuedCount: Int
    let onSend: (String, [ImageContent]) -> Void
    let onStop: () -> Void

    @Environment(\.theme) private var theme

    @State private var text = ""
    @State private var isMultiline = false
    @State private var measuredHeight: Double = ComposerLayout.minHeight
    @State private var images: [ImageContent] = []
    @State private var photoItems: [PhotosPickerItem] = []

    private var canSend: Bool {
        ComposerLayout.canSend(text: text, imageCount: images.count, disabled: false)
    }

    var body: some View {
        VStack(spacing: 8) {
            if queuedCount > 0 { queueBadge }
            if !images.isEmpty { imagePreview }
            card
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .background(theme.bgSecondary)
        .accessibilityIdentifier("mobile-composer")
        .onChange(of: text) { _, _ in recomputeLayout() }
        .onChange(of: photoItems) { _, items in Task { await loadImages(items) } }
    }

    // MARK: card (one stable tree, two layouts)

    private var card: some View {
        Group {
            if isMultiline {
                VStack(spacing: 8) {
                    textEditor
                    HStack(spacing: 8) { attachButton; Spacer(); controlCluster }
                }
            } else {
                HStack(alignment: .bottom, spacing: 8) {
                    attachButton
                    textEditor
                    controlCluster
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, isMultiline ? 10 : 8)
        .background(theme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(theme.borderSecondary, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .frame(minHeight: isMultiline ? nil : 48)
        .accessibilityIdentifier("mobile-composer-card")
        .accessibilityValue(isMultiline ? "multiline" : "single-row")
    }

    private var textEditor: some View {
        GrowingTextView(
            text: $text,
            minHeight: ComposerLayout.minHeight,
            maxHeight: ComposerLayout.maxHeight,
            onHeightChange: { h in
                measuredHeight = h
                recomputeLayout(contentHeight: h)
            })
        .frame(height: ComposerLayout.clampedHeight(text: text, measured: measuredHeight))
        .frame(maxWidth: .infinity)
    }

    private var attachButton: some View {
        PhotosPicker(selection: $photoItems, maxSelectionCount: 4, matching: .images) {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(theme.textSecondary)
                .frame(width: 36, height: 36)
                .background(theme.bgTertiary)
                .clipShape(Circle())
        }
        .accessibilityIdentifier("mobile-composer-attach")
    }

    private var controlCluster: some View {
        HStack(spacing: 8) {
            if isWorking {
                Button(action: stop) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 15))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(theme.accentRed)
                        .clipShape(Circle())
                }
                .accessibilityIdentifier("mobile-composer-stop")
            }
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(canSend ? .black : theme.textTertiary)
                    .frame(width: 40, height: 40)
                    .background(canSend ? Color.white : theme.bgTertiary)
                    .clipShape(Circle())
            }
            .disabled(!canSend)
            .accessibilityIdentifier("mobile-composer-send")
        }
    }

    private var queueBadge: some View {
        HStack(spacing: 6) {
            Circle().fill(theme.accentBlue).frame(width: 6, height: 6)
            Text("\(queuedCount) queued").font(.caption2)
        }
        .foregroundStyle(theme.textSecondary)
        .padding(.horizontal, 10).padding(.vertical, 4)
        .background(theme.bgTertiary)
        .clipShape(Capsule())
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("mobile-composer-queue-badge")
    }

    private var imagePreview: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(images.enumerated()), id: \.offset) { idx, img in
                    if let data = Data(base64Encoded: img.data), let ui = UIImage(data: data) {
                        Image(uiImage: ui)
                            .resizable().scaledToFill()
                            .frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .overlay(alignment: .topTrailing) {
                                Button { images.remove(at: idx) } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .foregroundStyle(.white, .black.opacity(0.6))
                                }
                                .padding(2)
                            }
                    }
                }
            }
            .padding(.horizontal, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: actions

    private func recomputeLayout(contentHeight: Double? = nil) {
        let h = contentHeight ?? measuredHeight
        isMultiline = ComposerLayout.isMultiline(previous: isMultiline, text: text, contentHeight: h)
    }

    private func send() {
        guard canSend else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onSend(text.trimmingCharacters(in: .whitespacesAndNewlines), images)
        text = ""
        images = []
        photoItems = []
        measuredHeight = ComposerLayout.minHeight
        isMultiline = false
    }

    private func stop() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        onStop()
    }

    private func loadImages(_ items: [PhotosPickerItem]) async {
        var loaded: [ImageContent] = []
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let mime = Self.mimeType(for: data)
            loaded.append(ImageContent(data: data.base64EncodedString(), mimeType: mime))
        }
        if !loaded.isEmpty { images.append(contentsOf: loaded) }
    }

    /// Sniff a supported image mime from magic bytes (jpeg/png/gif/webp).
    private static func mimeType(for data: Data) -> String {
        let bytes = [UInt8](data.prefix(12))
        if bytes.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if bytes.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
        if bytes.starts(with: [0x47, 0x49, 0x46]) { return "image/gif" }
        if bytes.count >= 12, Array(bytes[0..<4]) == [0x52, 0x49, 0x46, 0x46], Array(bytes[8..<12]) == [0x57, 0x45, 0x42, 0x50] {
            return "image/webp"
        }
        return "image/png"
    }
}
