import SwiftUI
import PiDashboardKit

/// Main shell once connected: a NavigationStack hosting the session list, with the
/// ConnectionBanner pinned at the top for disconnect/reconnect states.
struct MainView: View {
    @Environment(DashboardStore.self) private var store
    @Environment(ThemeController.self) private var themeController
    @Environment(\.theme) private var theme
    @State private var showNewSession = false
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            ZStack(alignment: .top) {
                theme.bgPrimary.ignoresSafeArea()
                SessionListView()
                ConnectionBanner()
            }
            .navigationTitle("pi dashboard")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(theme.bgSecondary, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                            .foregroundStyle(theme.textSecondary)
                    }
                    .accessibilityIdentifier("settings-button")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showNewSession = true
                    } label: {
                        Image(systemName: "plus.circle.fill")
                            .foregroundStyle(theme.accentBlue)
                    }
                    .accessibilityIdentifier("new-session-button")
                }
            }
            .sheet(isPresented: $showNewSession) {
                NewSessionSheet()
                    .environment(store)
                    .environment(\.theme, theme)
                    .presentationDetents([.medium, .large])
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
                    .environment(store)
                    .environment(themeController)
                    .environment(\.theme, theme)
            }
        }
        .tint(theme.accentBlue)
    }
}

/// "+ New session" picker — spawn a fresh session in a directory the app already
/// knows (session groups ∪ pinned dirs). TIGHT scope: known dirs only, server
/// defaults; the filesystem browser + model/name/flags are deferred. Tapping a dir
/// fires `store.spawn(cwd:)` and dismisses; the new session appearing in the list is
/// the confirm (a "Starting…" row shows meanwhile).
struct NewSessionSheet: View {
    @Environment(DashboardStore.self) private var store
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if store.knownDirectories.isEmpty {
                    emptyState
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Start a session in a known directory")
                                .font(.caption)
                                .foregroundStyle(theme.textTertiary)
                                .padding(.horizontal, 4)
                            ForEach(store.knownDirectories, id: \.self) { dir in
                                directoryRow(dir)
                            }
                        }
                        .padding(16)
                    }
                }
            }
            .background(theme.bgPrimary)
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(theme.accentBlue)
                }
            }
        }
        .accessibilityIdentifier("new-session-sheet")
    }

    private func directoryRow(_ dir: String) -> some View {
        let basename = dir.split(separator: "/").last.map(String.init) ?? dir
        let spawning = store.isSpawning(dir)
        return Button {
            guard !spawning else { return }
            Task { await store.spawn(cwd: dir) }
            dismiss()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "folder")
                    .foregroundStyle(theme.accentBlue)
                VStack(alignment: .leading, spacing: 2) {
                    Text(basename)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(theme.textPrimary)
                        .lineLimit(1)
                    Text(dir)
                        .font(.caption2)
                        .foregroundStyle(theme.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                Spacer(minLength: 8)
                if spawning {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.mini).tint(theme.statusActive)
                        Text("Starting…").font(.caption2).foregroundStyle(theme.statusActive)
                    }
                } else {
                    Image(systemName: "plus.circle").foregroundStyle(theme.textTertiary)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.bgTertiary)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("new-session-dir-\(basename)")
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "folder.badge.questionmark")
                .font(.largeTitle).foregroundStyle(theme.textTertiary)
            Text("No known directories yet")
                .foregroundStyle(theme.textSecondary)
            Text("Directories appear here once sessions run in them.")
                .font(.caption).foregroundStyle(theme.textTertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
        .padding(.horizontal, 24)
    }
}

/// Disconnect/reconnect banner — mirrors the PWA's >3s disconnect banner. Visible
/// only in `.reconnecting` / `.failed` while the dashboard is entered. Identifier:
/// `connection-banner` (TEST-CONTRACT §A).
struct ConnectionBanner: View {
    @Environment(DashboardStore.self) private var store
    @Environment(\.theme) private var theme

    var body: some View {
        Group {
            switch store.phase {
            case .reconnecting:
                banner(color: theme.accentOrange, icon: "arrow.triangle.2.circlepath",
                       text: "Reconnecting…")
            case .failed(let message):
                banner(color: theme.accentRed, icon: "wifi.slash", text: message)
            default:
                EmptyView()
            }
        }
    }

    private func banner(color: Color, icon: String, text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
            Text(text).font(.footnote.weight(.medium))
            Spacer()
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(color.opacity(0.92))
        .transition(.move(edge: .top).combined(with: .opacity))
        .accessibilityIdentifier("connection-banner")
    }
}
