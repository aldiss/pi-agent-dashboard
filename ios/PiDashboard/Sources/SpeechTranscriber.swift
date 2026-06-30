import Foundation
import Observation
import AVFoundation
import Speech
import UIKit
import PiDashboardKit

/// Native on-device speech→text engine backing the composer mic. Live partial
/// results stream out via `onUpdate` (already composed onto the caller's base draft
/// through the core `TranscriptAppender`), matching the PWA `onTranscript` UX.
///
/// `@MainActor @Observable` so SwiftUI reads `isRecording` / `permissionDenied` /
/// `errorMessage` directly. On-device recognition is preferred when supported;
/// the recognizer locale prefers `ru-RU` (operator dictates in Russian) via the
/// core `SpeechLocalePicker`, else the device locale.
@MainActor
@Observable
final class SpeechTranscriber {
    private(set) var isRecording = false
    private(set) var permissionDenied = false
    private(set) var errorMessage: String?
    /// The resolved recognizer locale (for status/debug + CC-VOICE-STATUS evidence).
    let localeIdentifier: String

    private let recognizer: SFSpeechRecognizer?
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var base = ""
    private var onUpdate: ((String) -> Void)?

    init() {
        let available = SFSpeechRecognizer.supportedLocales().map { $0.identifier }
        let chosen = SpeechLocalePicker.preferred(
            available: available, device: Locale.current.identifier)
        self.localeIdentifier = chosen
        self.recognizer = SFSpeechRecognizer(locale: Locale(identifier: chosen))
            ?? SFSpeechRecognizer()
    }

    /// Tap-to-talk toggle: starts recording (requesting permission on first use) or
    /// stops + finalizes. `base` is the current draft; `onUpdate` receives the draft
    /// with the live transcript composed on, on every partial + the final result.
    func toggle(base: String, onUpdate: @escaping (String) -> Void) {
        if isRecording { stop() } else { start(base: base, onUpdate: onUpdate) }
    }

    func start(base: String, onUpdate: @escaping (String) -> Void) {
        guard !isRecording else { return }
        errorMessage = nil
        self.base = base
        self.onUpdate = onUpdate
        Task { [weak self] in
            guard let self else { return }
            let granted = await Self.requestPermissions()
            if granted {
                self.beginSession()
            } else {
                self.permissionDenied = true
            }
        }
    }

    func stop() {
        // Stop capturing so the recognizer can finalize; the final result callback
        // tears the task down. Idempotent.
        guard isRecording else { return }
        audioEngine.inputNode.removeTap(onBus: 0)
        if audioEngine.isRunning { audioEngine.stop() }
        request?.endAudio()
        isRecording = false
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    // MARK: - permissions (both required; iOS 17 APIs)

    private static func requestPermissions() async -> Bool {
        let speech: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0) }
        }
        guard speech == .authorized else { return false }
        return await withCheckedContinuation { cont in
            AVAudioApplication.requestRecordPermission { cont.resume(returning: $0) }
        }
    }

    // MARK: - session

    private func beginSession() {
        guard let recognizer, recognizer.isAvailable else {
            errorMessage = "Speech recognition unavailable on this device."
            return
        }
        teardownTask()

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        self.request = request

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            errorMessage = "Couldn't start audio session."
            return
        }

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        // The tap block runs on the realtime audio thread; appending buffers to the
        // recognition request is the documented thread-safe sink.
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            errorMessage = "Couldn't start the microphone."
            cleanupAudio()
            return
        }

        isRecording = true
        UINotificationFeedbackGenerator().notificationOccurred(.success)

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            // Runs off the main actor → extract only Sendable primitives, then hop.
            let transcript = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor [weak self] in
                self?.handleResult(transcript: transcript, isFinal: isFinal, failed: failed)
            }
        }
    }

    private func handleResult(transcript: String?, isFinal: Bool, failed: Bool) {
        if let transcript, !transcript.isEmpty {
            onUpdate?(TranscriptAppender.append(base: base, transcript: transcript))
        }
        if isFinal || failed {
            if failed, errorMessage == nil { /* benign cancel on stop — no banner */ }
            teardownTask()
            isRecording = false
        }
    }

    private func teardownTask() {
        task?.cancel()
        task = nil
        request = nil
        cleanupAudio()
    }

    private func cleanupAudio() {
        if audioEngine.isRunning { audioEngine.stop() }
        audioEngine.inputNode.removeTap(onBus: 0)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
