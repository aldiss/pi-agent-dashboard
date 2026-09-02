import SwiftUI
import PhotosUI
import UIKit
import ImageIO
import UniformTypeIdentifiers
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
    /// The operator `pi_dash_token` cookie — carried on the voice sidecar's REST calls
    /// (transcribe/health) so they pass the multi-operator gate with operator identity.
    let serverCookie: String?
    let onSend: (String, [ImageContent]) async -> Bool
    let onStop: () -> Void
    /// Optional one-time seed for the draft (the `-uitest-composer-overflow` probe
    /// pre-fills a long line to screenshot-verify wrapping). nil in normal use.
    var initialText: String? = nil

    @Environment(\.theme) private var theme
    @Environment(ThemeController.self) private var themeController
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Binding private var text: String
    @State private var isMultiline = false
    @State private var measuredHeight: Double = ComposerLayout.minHeight
    @Binding private var images: [ImageContent]
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var voice = VoiceRecorder()
    @State private var micPulse = false
    /// Armed by a programmatic append (voice transcript / probe seed) so the NEXT
    /// measured-height update triggers ONE layout recompute — a dictated/seeded long
    /// no-newline line sets `text` in one shot, so the `.onChange(of: text)` recompute
    /// runs against the PRE-append (stale) height and can't flip; the real wrapped
    /// height arrives async via `onHeightChange`, and this flag lets that one landing
    /// re-flip. One-shot so ordinary streaming re-renders never churn `isMultiline`.
    @State private var pendingProgrammaticLayout = false
    /// Marks the NEXT `text` change as programmatic (send-clear / voice-append) so the
    /// text view force-applies it; a lagging streaming re-render never clobbers typing.
    @State private var textSignal = ComposerTextSignal()
    /// One tap → one client nonce while the local socket send is awaiting completion.
    @State private var sendInFlight = false

    init(isWorking: Bool, queuedCount: Int, serverBase: URL?, serverToken: String?,
         serverCookie: String?, onSend: @escaping (String, [ImageContent]) async -> Bool,
         onStop: @escaping () -> Void, initialText: String? = nil,
         text: Binding<String>, images: Binding<[ImageContent]>) {
        self.isWorking = isWorking
        self.queuedCount = queuedCount
        self.serverBase = serverBase
        self.serverToken = serverToken
        self.serverCookie = serverCookie
        self.onSend = onSend
        self.onStop = onStop
        self.initialText = initialText
        _text = text
        _images = images
    }

    private var canSend: Bool {
        !sendInFlight && ComposerLayout.canSend(
            text: text, imageCount: images.count, disabled: false)
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
        // A voice/probe append sets `text` in ONE shot: the `.onChange(of: text)` above
        // recomputes against the PRE-append (stale) `measuredHeight`, so a long dictated
        // no-newline line can't flip on that pass. The real wrapped height lands async via
        // `onHeightChange`; recompute ONCE here to let it flip. One-shot-gated
        // (`pendingProgrammaticLayout`) so ordinary streaming re-renders that also move
        // `measuredHeight` never churn `isMultiline` — the exact teardown the height-driven
        // recompute was removed to avoid.
        .onChange(of: measuredHeight) { _, _ in
            if pendingProgrammaticLayout {
                pendingProgrammaticLayout = false
                recomputeLayout()
            }
        }
        .onChange(of: photoItems) { _, items in Task { await loadImages(items) } }
        .onAppear {
            voice.configure(base: serverBase, token: serverToken, cookie: serverCookie)
            voice.onAppear()
            // Probe seed: pre-fill the draft ONCE with the overflow test line so the
            // wrap fix is screenshot-visible. Programmatic so the text view applies it;
            // recompute so the long line's height flips isMultiline.
            if let seed = initialText, text.isEmpty {
                textSignal.markProgrammatic()
                pendingProgrammaticLayout = true // seed is a one-shot long-line set → same async re-flip path
                text = seed
                recomputeLayout()
            }
        }
        .onChange(of: serverBase) { _, base in voice.configure(base: base, token: serverToken, cookie: serverCookie) }
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

    // MARK: card (ONE stable element tree, two layouts)
    //
    // CRITICAL: `textEditor` must occupy the SAME structural position in BOTH layouts
    // or SwiftUI assigns it a new identity on the single-row⇄multiline flip and TEARS
    // DOWN the underlying UITextView — which resigns first responder (keyboard drops)
    // and loses the in-flight draft/caret. So the top row ALWAYS renders
    // `[attach?, textEditor, controls?]` with `textEditor` at a FIXED slot; the
    // attach/send controls are the only things that reflow: inline (single-row) vs a
    // conditional SECOND ROW (multiline). No `if/else` ever wraps `textEditor`.
    private var card: some View {
        VStack(spacing: 8) {
            HStack(alignment: .bottom, spacing: 8) {
                if !isMultiline { attachButton }   // single-row: attach leads inline
                textEditor                          // ← STABLE slot in both layouts
                if !isMultiline { controlCluster } // single-row: controls trail inline
            }
            if isMultiline {
                // multiline: attach + controls drop to their own row UNDER the editor.
                HStack(spacing: 8) { attachButton; Spacer(); controlCluster }
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
            // Height feeds the frame + the NEXT text-driven recompute ONLY. It must NOT
            // itself drive `recomputeLayout` — that let every per-updateUIView measure
            // (fired on each streaming re-render) churn `isMultiline` → teardown. Layout
            // now flips purely from `.onChange(of: text)`.
            onHeightChange: { h in measuredHeight = h },
            signal: textSignal,
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
        .accessibilityLabel("Add photo")
        .accessibilityHint("Choose up to four images")
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
                .accessibilityLabel("Stop response")
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
            .accessibilityLabel(isWorking ? "Queue message" : "Send message")
            .accessibilityHint(isWorking ? "Adds this message after the current response" : "Sends this message")
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
        .disabled(voice.isUploading || (!voice.micEnabled && !voice.isRecording))
        .accessibilityIdentifier("mobile-composer-mic")
        .accessibilityValue(micAccessibilityValue)
        .accessibilityLabel(
            voice.isStarting ? "Cancel microphone start" :
            (voice.isUploading ? "Transcribing recording" :
             (voice.isRecording ? "Stop recording" :
              (voice.micEnabled ? "Record voice" : "Voice service starting"))))
        .onAppear { micPulse = false }
        // Reduce Motion (Cluster 5): no infinite repeat when the user asked to reduce
        // motion — fall back to a non-looping default.
        .animation(voice.isRecording && A11yMotion.pulsesEnabled(reduceMotion: reduceMotion)
            ? .easeOut(duration: 1.0).repeatForever(autoreverses: false)
            : .default, value: micPulse)
    }

    @ViewBuilder private var micGlyph: some View {
        if voice.isUploading || voice.phase == .starting {
            ProgressView().controlSize(.small).tint(theme.textSecondary)
        } else {
            Image(systemName: voice.isRecording ? "waveform" : "mic.fill")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(voice.isRecording ? .white : theme.textSecondary)
        }
    }

    private var micAccessibilityValue: String {
        switch voice.phase {
        case .starting: return "starting"
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
            // Queued work is a STATUS (pending send), not an interactive control, so it
            // carries the amber working hue — never the blue/terracotta interaction
            // accent (engine-b §4.9, blue=interaction-only).
            Circle().fill(theme.statusWorking).frame(width: 6, height: 6)
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
                                .accessibilityLabel("Remove attachment \(idx + 1)")
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

    /// Recompute the single-row⇄multiline layout. Driven ONLY by `.onChange(of: text)`
    /// (a real edit), never by the per-`updateUIView` height callback — so a streaming
    /// re-render can't churn `isMultiline` and tear the text view down. Reads the latest
    /// `measuredHeight`, which `textViewDidChange` refreshed synchronously on the edit.
    private func recomputeLayout() {
        isMultiline = ComposerLayout.isMultiline(previous: isMultiline, text: text, contentHeight: measuredHeight)
    }

    private func send() {
        guard canSend else { return }
        sendInFlight = true
        let outgoingText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let outgoingImages = images
        Haptics.success()
        Task {
            let accepted = await onSend(outgoingText, outgoingImages)
            sendInFlight = false
            guard accepted else { return } // keep editable draft/images on local failure
            // A send normally resolves immediately. If the operator edited while it
            // awaited the socket, never erase that newer draft/attachment state.
            guard text.trimmingCharacters(in: .whitespacesAndNewlines) == outgoingText,
                  images == outgoingImages else { return }
            textSignal.markProgrammatic() // force clear through while first responder
            text = ""
            images = []
            photoItems = []
            measuredHeight = ComposerLayout.minHeight
            isMultiline = false
        }
    }

    private func stop() {
        Haptics.warning()
        onStop()
    }

    /// Tap-to-talk: idle → record → (tap) stop+upload → transcript appended to the
    /// draft via the core `TranscriptAppender`. The pulse flag flips on so the ring
    /// loops while recording.
    private func toggleMic() {
        voice.toggle { transcript in
            textSignal.markProgrammatic() // voice transcript is a programmatic append
            pendingProgrammaticLayout = true // arm the one-shot re-flip once the wrapped height lands
            // Append to the CURRENT draft. Text typed during recording/uploading is
            // preserved instead of being overwritten by a stale recording-start copy.
            text = TranscriptAppender.append(base: text, transcript: transcript)
        }
        micPulse = false
        DispatchQueue.main.async { micPulse = true }
    }

    private func loadImages(_ items: [PhotosPickerItem]) async {
        var loaded: [ImageContent] = []
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let sourceMime = Self.mimeType(for: data)
                ?? item.supportedContentTypes.compactMap(\.preferredMIMEType).first
                ?? "application/octet-stream"
            let prepared = Self.prepareImageForSend(data, mimeType: sourceMime)
            loaded.append(ImageContent(
                data: prepared.data.base64EncodedString(),
                mimeType: prepared.mimeType))
        }
        if !loaded.isEmpty { images.append(contentsOf: loaded) }
    }

    /// Decode the container identifier so HEIC data never falls through as PNG.
    private static func mimeType(for data: Data) -> String? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let identifier = CGImageSourceGetType(source) else { return nil }
        return UTType(identifier as String)?.preferredMIMEType
    }

    /// Downscale supported images before base64 encoding. Every failure path keeps
    /// the original bytes and MIME so attaching an image never blocks a send.
    private static func prepareImageForSend(
        _ data: Data,
        mimeType: String
    ) -> (data: Data, mimeType: String) {
        let original = (data: data, mimeType: mimeType)
        guard let outputMime = resizeOutputMime(for: mimeType),
              let image = UIImage(data: data) else { return original }

        let dimensions = ImageResizePolicy.computeResizeDimensions(
            width: Double(image.size.width * image.scale),
            height: Double(image.size.height * image.scale))
        guard dimensions.resized else { return original }

        let targetSize = CGSize(
            width: CGFloat(dimensions.width),
            height: CGFloat(dimensions.height))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = outputMime == "image/jpeg"
        let resized = UIGraphicsImageRenderer(size: targetSize, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }

        guard let encoded = encodedData(
            for: resized,
            preferredMimeType: outputMime,
            sourceHasAlpha: hasAlpha(image)) else {
            return original
        }
        return encoded
    }

    /// Web formats prefer their MIME; unsupported WebP output cross-encodes truthfully.
    /// Native HEIC/HEIF extends the web set and converts oversized images to JPEG.
    private static func resizeOutputMime(for sourceMime: String) -> String? {
        if ImageResizePolicy.isResizableImageMime(sourceMime) { return sourceMime }
        if sourceMime == "image/heic" || sourceMime == "image/heif" { return "image/jpeg" }
        return nil
    }

    private static func encodedData(
        for image: UIImage,
        preferredMimeType: String,
        sourceHasAlpha: Bool
    ) -> (data: Data, mimeType: String)? {
        switch preferredMimeType {
        case "image/jpeg":
            return image.jpegData(compressionQuality: CGFloat(ImageResizePolicy.lossyQuality))
                .map { (data: $0, mimeType: "image/jpeg") }
        case "image/png":
            return image.pngData().map { (data: $0, mimeType: "image/png") }
        case "image/webp":
            if let data = webPData(for: image) {
                return (data: data, mimeType: "image/webp")
            }
            if sourceHasAlpha {
                return image.pngData().map { (data: $0, mimeType: "image/png") }
            }
            return image.jpegData(compressionQuality: CGFloat(ImageResizePolicy.lossyQuality))
                .map { (data: $0, mimeType: "image/jpeg") }
        default:
            return nil
        }
    }

    private static func hasAlpha(_ image: UIImage) -> Bool {
        guard let alphaInfo = image.cgImage?.alphaInfo else { return true }
        switch alphaInfo {
        case .first, .last, .premultipliedFirst, .premultipliedLast, .alphaOnly:
            return true
        default:
            return false
        }
    }

    private static func webPData(for image: UIImage) -> Data? {
        guard let cgImage = image.cgImage,
              let output = CFDataCreateMutable(nil, 0),
              let destination = CGImageDestinationCreateWithData(
                output, UTType.webP.identifier as CFString, 1, nil) else { return nil }
        let properties = [
            kCGImageDestinationLossyCompressionQuality: ImageResizePolicy.lossyQuality
        ] as CFDictionary
        CGImageDestinationAddImage(destination, cgImage, properties)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }
}
