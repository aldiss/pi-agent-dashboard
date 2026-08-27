import Foundation
import Observation
import AVFoundation
import UIKit
import PiDashboardKit

/// Records mic audio to an m4a file and uploads it to the dashboard's **parakeet
/// voice sidecar** for transcription — the exact backend the PWA uses (operator has
/// it tuned for Russian). Replaces the prior on-device `SFSpeechRecognizer`.
///
/// `@MainActor @Observable` so the composer reads `phase` / `isHealthy` /
/// `errorMessage` directly. The pure HTTP contract (URLs, multipart, decode) lives
/// in the core `VoiceTranscriber`; this owns the device-only pieces: recording,
/// permission, the `URLSession` upload, and the 5s health-gate poll.
@MainActor
@Observable
final class VoiceRecorder {
    enum Phase: Equatable { case idle, starting, recording, uploading }

    private(set) var phase: Phase = .idle
    private(set) var isHealthy = false
    private(set) var permissionDenied = false
    private(set) var errorMessage: String?
    private static let httpSession = URLSession(
        configuration: DashboardSessionConfiguration.make()
    )

    var isStarting: Bool { phase == .starting }
    var isRecording: Bool { phase == .recording }
    var isUploading: Bool { phase == .uploading }
    /// Mic is actionable only when the sidecar is reachable + healthy.
    var micEnabled: Bool { isHealthy || phase != .idle }

    /// Connection context (the dashboard the app is connected to). Injected by the
    /// composer from `DashboardStore`; never hardcoded.
    private var serverBase: URL?
    private var token: String?
    /// The operator `pi_dash_token` cookie — attached to the transcribe/health REST
    /// calls so they pass the multi-operator gate with operator identity.
    private var cookie: String?

    private var recorder: AVAudioRecorder?
    private var fileURL: URL?
    private var startTask: Task<Void, Never>?
    private var healthTask: Task<Void, Never>?
    private var autoStopTask: Task<Void, Never>?
    private var errorClearTask: Task<Void, Never>?
    private var backgroundObserver: NSObjectProtocol?

    /// Hard ceiling so a forgotten recording can't run forever (brief: 10 min).
    private let maxRecordingSeconds: UInt64 = 10 * 60
    /// Below this the file is almost certainly silence/empty — skip the upload.
    private let minUploadBytes = 1500

    // MARK: configuration + lifecycle

    /// Point the recorder at the connected dashboard. Called whenever base/token/cookie
    /// change; restarts the health poll against the new server.
    func configure(base: URL?, token: String?, cookie: String?) {
        let changed = base != serverBase || token != self.token || cookie != self.cookie
        serverBase = base
        self.token = token
        self.cookie = cookie
        if changed { restartHealthPolling() }
    }

    /// Start the 5s sidecar-health poll (while the composer is on screen) + observe
    /// backgrounding so a mid-recording background flushes the upload.
    func onAppear() {
        restartHealthPolling()
        if backgroundObserver == nil {
            backgroundObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.handleBackground() }
            }
        }
    }

    func onDisappear() {
        healthTask?.cancel(); healthTask = nil
        startTask?.cancel(); startTask = nil
        pendingStop = false
        if phase == .starting { phase = .idle }
        autoStopTask?.cancel(); autoStopTask = nil
        if let backgroundObserver {
            NotificationCenter.default.removeObserver(backgroundObserver)
            self.backgroundObserver = nil
        }
        if isRecording { cancelRecording() }
    }

    // MARK: tap-to-talk

    /// idle → starting(permission) → recording → uploading → idle.
    func toggle(onTranscript: @escaping (String) -> Void) {
        switch phase {
        case .idle: start(onTranscript: onTranscript)
        case .starting: pendingStop = true // second tap = queued cancel, matching PWA
        case .recording: stopAndUpload()
        case .uploading: break
        }
    }

    private var onTranscript: ((String) -> Void)?
    private var pendingStop = false

    private func start(onTranscript: @escaping (String) -> Void) {
        guard serverBase != nil else {
            showError("Not connected to a server."); return
        }
        phase = .starting // closes the duplicate-start race immediately
        pendingStop = false
        self.onTranscript = onTranscript
        errorMessage = nil
        startTask = Task { [weak self] in
            guard let self else { return }
            let granted = await Self.requestMicPermission()
            guard !Task.isCancelled, self.phase == .starting else { return }
            self.startTask = nil
            if self.pendingStop {
                self.pendingStop = false
                self.phase = .idle
                return
            }
            if granted { self.beginRecording() }
            else { self.phase = .idle; self.permissionDenied = true }
        }
    }

    private func beginRecording() {
        guard phase == .starting else { return }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("pi-voice-\(ProcessInfo.processInfo.globallyUniqueString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.duckOthers, .defaultToSpeaker])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let rec = try AVAudioRecorder(url: url, settings: settings)
            guard rec.record() else {
                phase = .idle
                showError("Couldn't start the microphone."); deactivateSession(); return
            }
            recorder = rec
            fileURL = url
            phase = .recording
            Haptics.success()
            // 10-min auto-stop safety.
            autoStopTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: (self?.maxRecordingSeconds ?? 600) * 1_000_000_000)
                if !Task.isCancelled { await self?.stopAndUpload() }
            }
        } catch {
            phase = .idle
            showError("Couldn't start audio recording.")
            deactivateSession()
        }
    }

    private func stopAndUpload() {
        guard phase == .recording, let rec = recorder, let url = fileURL else { return }
        autoStopTask?.cancel(); autoStopTask = nil
        rec.stop()
        recorder = nil
        deactivateSession()
        Haptics.warning()

        guard let data = try? Data(contentsOf: url), data.count >= minUploadBytes else {
            try? FileManager.default.removeItem(at: url)
            fileURL = nil
            phase = .idle
            showError("Recording too short — try again.")
            return
        }
        phase = .uploading
        let base = serverBase
        let token = self.token
        let cookie = self.cookie
        Task { [weak self] in
            await self?.upload(data: data, base: base, token: token, cookie: cookie, fileURL: url)
        }
    }

    private func upload(data: Data, base: URL?, token: String?, cookie: String?, fileURL: URL) async {
        defer { try? FileManager.default.removeItem(at: fileURL) }
        guard let base else { finishUpload(error: "Not connected to a server."); return }
        let req = VoiceTranscriber.transcribeRequest(
            base: base, audio: data, boundary: UUID().uuidString, token: token, cookie: cookie)
        do {
            let (body, response) = try await Self.httpSession.data(for: req)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                finishUpload(error: "Transcription failed (\(status)). Try again.")
                return
            }
            switch VoiceTranscriber.parseTranscript(body) {
            case .success(let transcript):
                // Composer appends to its CURRENT binding. Never compose here against
                // text captured at recording start; the operator may have typed since.
                onTranscript?(transcript)
                finishUpload(error: nil)
            case .failure(.emptyTranscript):
                finishUpload(error: "No speech detected — try again.")
            case .failure(.malformed):
                finishUpload(error: "Couldn't read the transcription. Try again.")
            }
        } catch {
            finishUpload(error: "Couldn't reach the voice service.")
        }
    }

    private func finishUpload(error: String?) {
        phase = .idle
        fileURL = nil
        if let error { showError(error) }
    }

    private func cancelRecording() {
        autoStopTask?.cancel(); autoStopTask = nil
        recorder?.stop()
        recorder = nil
        if let url = fileURL { try? FileManager.default.removeItem(at: url) }
        fileURL = nil
        deactivateSession()
        phase = .idle
    }

    private func handleBackground() {
        // Flush a mid-recording upload when the app backgrounds (brief).
        if phase == .recording { stopAndUpload() }
    }

    // MARK: permission

    private static func requestMicPermission() async -> Bool {
        await withCheckedContinuation { cont in
            AVAudioApplication.requestRecordPermission { cont.resume(returning: $0) }
        }
    }

    // MARK: health gate (poll every 5s while on screen)

    private func restartHealthPolling() {
        healthTask?.cancel()
        guard let base = serverBase else { isHealthy = false; return }
        let token = self.token
        let cookie = self.cookie
        healthTask = Task { [weak self] in
            while !Task.isCancelled {
                let healthy = await Self.probeHealth(base: base, token: token, cookie: cookie)
                await MainActor.run { self?.isHealthy = healthy }
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    private static func probeHealth(base: URL, token: String?, cookie: String?) async -> Bool {
        let req = VoiceTranscriber.healthRequest(base: base, token: token, cookie: cookie)
        guard let (body, response) = try? await httpSession.data(for: req) else { return false }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return VoiceTranscriber.parseHealthy(body, statusCode: status)
    }

    // MARK: helpers

    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Show an inline error that auto-clears after ~6s (brief).
    private func showError(_ message: String) {
        errorMessage = message
        errorClearTask?.cancel()
        errorClearTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if !Task.isCancelled { self?.errorMessage = nil }
        }
    }
}
