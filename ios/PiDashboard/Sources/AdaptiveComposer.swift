import SwiftUI
import PhotosUI
import UIKit
import PiDashboardKit

/// Native port of the PWA `MobileComposer`. The single-row⇄column flip, height
/// clamp, and send-gating ALL come from the core's `ComposerLayout` (the same rule
/// the unit tests pin) — this view only renders the two layouts over one stable
/// element tree. Identifiers + `accessibilityValue` single-row/multiline per
/// TEST-CONTRACT §A so the XCUITest can assert the hysteresis.
struct AdaptiveComposer: View {
    let isWorking: Bool
    let queuedCount: Int
    /// The dashboard the app is connected to — used to build the parakeet voice
    /// sidecar URLs. Passed from `DashboardStore` via `ChatView`; never hardcoded.
    let serverBase: URL?
    let serverToken: String?
    let onSend: (String, [ImageContent]) -> Void
    let onStop: () -> Void

    @Environment(\.theme) private var theme
    @Environment(ThemeController.self) private var themeController
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var text = ""
    @State private var isMultiline = false
    @State private var measuredHeight: Double = ComposerLayout.minHeight
    @State private var images: [ImageContent] = []
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var voice = VoiceRecorder()
    @State private var micPulse = false

    private var canSend: Bool {
        ComposerLayout.canSend(text: text, imageCount: images.count, disabled: false)
    }

    var body: some View {
        VStack(spacing: 8) {
            if queuedCount > 0 { queueBadge }
            if voice.permissionDenied { micPermissionHint }
            else if let err = voice.errorMessage { micErrorHint(err) }
            if !images.isEmpty { imagePreview }
            card
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .background(theme.bgSecondary)
        // NB: a SwiftUI `.accessibilityIdentifier` on this container would CASCADE
        // onto every descendant element (attach/textarea/send), overwriting their
        // own ids. So the container + layout identifiers live on dedicated zero-size
        // marker elements instead, leaving the controls' own ids intact.
        .overlay(alignment: .topLeading) { composerMarkers }
        .onChange(of: text) { _, _ in recomputeLayout() }
        .onChange(of: photoItems) { _, items in Task { await loadImages(items) } }
        .onAppear {
            voice.configure(base: serverBase, token: serverToken)
            voice.onAppear()
        }
        .onChange(of: serverBase) { _, base in voice.configure(base: base, token: serverToken) }
        .onDisappear { voice.onDisappear() }
    }

    /// Zero-size a11y markers: `mobile-composer` (outer container handle) and
    /// `mobile-composer-card` (layout value carrier, single-row/multiline per
    /// TEST-CONTRACT §A). Kept off the visual tree so they never cascade ids onto
    /// the real controls.
    private var composerMarkers: some View {
        ZStack {
            Color.clear.frame(width: 1, height: 1)
                .accessibilityElement()
                .accessibilityIdentifier("mobile-composer")
            Color.clear.frame(width: 1, height: 1)
                .accessibilityElement()
                .accessibilityIdentifier("mobile-composer-card")
                .accessibilityValue(isMultiline ? "multiline" : "single-row")
        }
        .frame(width: 1, height: 1)
        .allowsHitTesting(false)
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
    }

    private var textEditor: some View {
        GrowingTextView(
            text: $text,
            minHeight: ComposerLayout.minHeight,
            maxHeight: ComposerLayout.maxHeight,
            onHeightChange: { h in
                measuredHeight = h
                recomputeLayout(contentHeight: h)
            },
            textColor: theme.textPrimary,
            placeholderColor: theme.textTertiary,
            keyboardAppearance: keyboardAppearance)
        .frame(height: ComposerLayout.clampedHeight(text: text, measured: measuredHeight))
        .frame(maxWidth: .infinity)
    }

    /// Keyboard appearance follows the app's ThemeController (NOT the OS trait):
    /// light → `.light`, dark → `.dark`, system → `.default` (UIKit tracks the OS).
    private var keyboardAppearance: UIKeyboardAppearance {
        switch themeController.mode {
        case .light:  return .light
        case .dark:   return .dark
        case .system: return .default
        }
    }

    private var attachButton: some View {
        PhotosPicker(selection: $photoItems, maxSelectionCount: 4, matching: .images) {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(theme.textSecondary)
                .frame(width: 44, height: 44)
                .background(theme.bgTertiary)
                .clipShape(Circle())
        }
        .accessibilityIdentifier("mobile-composer-attach")
    }

    private var controlCluster: some View {
        HStack(spacing: 8) {
            micButton
            if isWorking {
                Button(action: stop) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 15))
                        .foregroundStyle(.white)
                        .frame(width: 44, height: 44)
                        .background(theme.accentRed)
                        .clipShape(Circle())
                }
                .accessibilityIdentifier("mobile-composer-stop")
            }
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(canSend ? .black : theme.textTertiary)
                    .frame(width: 44, height: 44)
                    .background(canSend ? Color.white : theme.bgTertiary)
                    .clipShape(Circle())
            }
            .disabled(!canSend)
            .accessibilityIdentifier("mobile-composer-send")
        }
    }

    /// Tap-to-talk mic — records audio + uploads to the parakeet sidecar (mirrors
    /// the PWA `PushToTalkButton` slot: right controls, before Send, 40×40). Phases:
    /// idle (`mic.fill`) → recording (accent pulse ring + `waveform`) → uploading
    /// (spinner). Disabled until the sidecar reports healthy.
    private var micButton: some View {
        Button(action: toggleMic) {
            ZStack {
                Circle()
                    .fill(voice.isRecording ? theme.accentBlue : theme.bgTertiary)
                    .frame(width: 44, height: 44)
                if voice.isRecording && A11yMotion.pulsesEnabled(reduceMotion: reduceMotion) {
                    // Reduce Motion off → the expanding pulse ring; on → the solid fill
                    // (line above) alone signals recording, no looping animation.
                    Circle()
                        .stroke(theme.accentBlue.opacity(0.5), lineWidth: 2)
                        .frame(width: 44, height: 44)
                        .scaleEffect(micPulse ? 1.35 : 1.0)
                        .opacity(micPulse ? 0 : 0.8)
                }
                micGlyph
            }
            .opacity(voice.micEnabled ? 1 : 0.4)
        }
        .disabled(!voice.micEnabled && !voice.isRecording && !voice.isUploading)
        .accessibilityIdentifier("mobile-composer-mic")
        .accessibilityValue(micAccessibilityValue)
        .accessibilityLabel(voice.isRecording ? "Stop recording" :
            (voice.micEnabled ? "Record voice" : "Voice service starting"))
        .onAppear { micPulse = false }
        // Reduce Motion (Cluster 5): no infinite repeat when the user asked to reduce
        // motion — fall back to a non-looping default.
        .animation(voice.isRecording && A11yMotion.pulsesEnabled(reduceMotion: reduceMotion)
            ? .easeOut(duration: 1.0).repeatForever(autoreverses: false)
            : .default, value: micPulse)
    }

    @ViewBuilder private var micGlyph: some View {
        if voice.isUploading {
            ProgressView().controlSize(.small).tint(theme.textSecondary)
        } else {
            Image(systemName: voice.isRecording ? "waveform" : "mic.fill")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(voice.isRecording ? .white : theme.textSecondary)
        }
    }

    private var micAccessibilityValue: String {
        switch voice.phase {
        case .recording: return "recording"
        case .uploading: return "uploading"
        case .idle: return voice.micEnabled ? "idle" : "disabled"
        }
    }

    private var micPermissionHint: some View {
        HStack(spacing: 8) {
            Image(systemName: "mic.slash.fill").font(.caption)
            Text("Microphone access is off.").font(.caption)
            Spacer(minLength: 4)
            Button("Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(theme.accentBlue)
        }
        .foregroundStyle(theme.textSecondary)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.bgTertiary)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityIdentifier("mobile-composer-mic-denied")
    }

    private func micErrorHint(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").font(.caption)
            Text(message).font(.caption)
            Spacer(minLength: 4)
        }
        .foregroundStyle(theme.accentOrange)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.bgTertiary)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
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

    /// Tap-to-talk: idle → record → (tap) stop+upload → transcript appended to the
    /// draft via the core `TranscriptAppender`. The pulse flag flips on so the ring
    /// loops while recording.
    private func toggleMic() {
        let recordingBase = text
        voice.toggle(base: recordingBase) { composed in
            text = composed
        }
        micPulse = false
        DispatchQueue.main.async { micPulse = true }
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
