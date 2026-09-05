import SwiftUI
import PiDashboardKit

/// Read-only transcript for an external Codex or Claude Code tmux pane.
struct ExternalTranscriptView: View {
    let sessionId: String
    let title: String

    @Environment(DashboardStore.self) private var store
    @Environment(\.theme) private var theme

    @State private var transcript: ExternalTranscriptResponse?
    @State private var phase: LoadPhase = .loading

    private enum LoadPhase: Equatable {
        case loading
        case loaded
        case notFound
        case failed
    }

    var body: some View {
        Group {
            switch phase {
            case .loading:
                ProgressView("Loading transcript…")
                    .tint(theme.accentBlue)
                    .foregroundStyle(theme.textSecondary)
                    .accessibilityIdentifier("external-transcript-loading")

            case .loaded:
                if let transcript {
                    transcriptContent(transcript)
                }

            case .notFound:
                unavailableState(
                    icon: "questionmark.folder",
                    title: "Session not found",
                    detail: "This external session is no longer available.")

            case .failed:
                unavailableState(
                    icon: "wifi.exclamationmark",
                    title: "Couldn’t load transcript",
                    detail: "Check the dashboard connection and try again.")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.bgPrimary)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: sessionId) { await load() }
    }

    private func transcriptContent(_ transcript: ExternalTranscriptResponse) -> some View {
        let rows = ExternalTranscriptMapper.rows(from: transcript.entries)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                if transcript.truncated {
                    Label("Transcript truncated by server", systemImage: "ellipsis.circle")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(theme.textSecondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(theme.bgTertiary)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .accessibilityIdentifier("external-transcript-truncated")
                }

                if rows.isEmpty {
                    unavailableState(
                        icon: "text.page.slash",
                        title: "No transcript entries",
                        detail: "The captured pane has no readable transcript.")
                        .padding(.top, 44)
                } else {
                    ForEach(rows) { row in
                        switch row {
                        case .message(let message):
                            ChatMessageRow(message: message)
                        case .status(let status):
                            statusRow(status)
                        }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
        .accessibilityIdentifier("external-transcript-scroll")
    }

    private func statusRow(_ status: ExternalTranscriptStatus) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "info.circle")
                .accessibilityHidden(true)
            Text(status.text)
            Spacer(minLength: 8)
            if let timestamp = status.timestamp {
                Text(Format.clockTime(fromEpochMs: timestamp))
            }
        }
        .font(.caption)
        .foregroundStyle(theme.textTertiary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("external-transcript-status-\(status.id)")
    }

    private func unavailableState(icon: String, title: String, detail: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon)
                .font(.largeTitle)
                .foregroundStyle(theme.textTertiary)
            Text(title)
                .font(.headline)
                .foregroundStyle(theme.textPrimary)
            Text(detail)
                .font(.callout)
                .foregroundStyle(theme.textSecondary)
                .multilineTextAlignment(.center)
            Button("Retry") { Task { await load() } }
                .font(.caption.weight(.semibold))
                .foregroundStyle(theme.accentBlue)
                .accessibilityIdentifier("external-transcript-retry")
        }
        .frame(maxWidth: .infinity)
        .padding(24)
    }

    @MainActor
    private func load() async {
        phase = .loading
        do {
            let loaded = try await store.externalTranscript(sessionId)
            guard !Task.isCancelled else { return }
            transcript = loaded
            phase = .loaded
        } catch is CancellationError {
            return
        } catch let error as DashboardClientError {
            guard !Task.isCancelled else { return }
            transcript = nil
            if case .httpStatus(404) = error {
                phase = .notFound
            } else {
                phase = .failed
            }
        } catch {
            guard !Task.isCancelled else { return }
            transcript = nil
            phase = .failed
        }
    }
}
