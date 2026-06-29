import SwiftUI
import PiDashboardKit

/// Main shell once connected: a NavigationStack hosting the session list, with the
/// ConnectionBanner pinned at the top for disconnect/reconnect states.
struct MainView: View {
    @Environment(DashboardStore.self) private var store
    @Environment(\.theme) private var theme

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
            .toolbarColorScheme(.dark, for: .navigationBar)
        }
        .tint(theme.accentBlue)
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
