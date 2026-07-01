import SwiftUI
import PiDashboardKit

@main
struct PiDashboardApp: App {
    @State private var store = DashboardStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(\.theme, .dark)
                .preferredColorScheme(.dark)
        }
    }
}

/// Top-level switch: ConnectView until a successful connect enters the dashboard,
/// then MainView. On first appear, `bootstrap()` auto-connects to a persisted
/// server (skipping the form) — an `AutoConnectSplash` covers that window. A fresh
/// install (no stored server) shows ConnectView directly. MainView stays mounted
/// across transient drops (the ConnectionBanner reflects `.reconnecting`); only an
/// explicit disconnect returns to ConnectView.
struct RootView: View {
    @Environment(DashboardStore.self) private var store
    @Environment(\.theme) private var theme

    var body: some View {
        ZStack {
            theme.bgPrimary.ignoresSafeArea()
            if store.hasEnteredDashboard {
                MainView()
            } else if store.isAutoConnecting {
                AutoConnectSplash()
            } else {
                ConnectView()
            }
        }
        .onAppear { store.bootstrap() }
    }
}

/// Shown while a launch auto-connect to the persisted server is in flight, so the
/// operator never sees (or re-enters) the connect form on a known device. Offers a
/// "Change server" escape hatch back to the editable form.
struct AutoConnectSplash: View {
    @Environment(DashboardStore.self) private var store
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            Text("pi dashboard")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(theme.textPrimary)
            HStack(spacing: 10) {
                ProgressView().tint(theme.textSecondary)
                Text("Connecting to \(store.serverURLString)…")
                    .font(.callout)
                    .foregroundStyle(theme.textSecondary)
            }
            Spacer()
            Button("Change server") { store.showConnectForm() }
                .font(.callout.weight(.medium))
                .foregroundStyle(theme.accentBlue)
                .padding(.bottom, 28)
                .accessibilityIdentifier("autoconnect-change-server")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("autoconnect-splash")
    }
}
