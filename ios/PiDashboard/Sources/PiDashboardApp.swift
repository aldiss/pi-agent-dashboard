import SwiftUI
import PiDashboardKit
import Observation

/// Holds the operator's persisted theme preference and drives the live theme. The
/// SwiftUI tree resolves the concrete `Theme` from `mode` + the OS appearance, so a
/// change here re-themes the whole app instantly. Persists on set via `ThemeModeStore`.
@MainActor
@Observable
final class ThemeController {
    var mode: ThemeMode {
        didSet { ThemeModeStore.save(mode) }
    }
    init() { mode = ThemeModeStore.load() }

    /// `preferredColorScheme` for the scene: nil for `.system` (follow the OS),
    /// else the pinned scheme.
    var colorSchemeOverride: ColorScheme? {
        switch mode {
        case .system: return nil
        case .dark:   return .dark
        case .light:  return .light
        }
    }
}

@main
struct PiDashboardApp: App {
    @State private var store = DashboardStore()
    @State private var themeController = ThemeController()
    @Environment(\.colorScheme) private var systemColorScheme
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            // Resolve the palette from the operator's mode + the OS appearance. For
            // `.system` this tracks `systemColorScheme` live; for a pinned mode the
            // `preferredColorScheme` below forces the scene so the two agree.
            let systemIsDark = themeController.colorSchemeOverride.map { $0 == .dark }
                ?? (systemColorScheme == .dark)
            RootView()
                .environment(store)
                .environment(themeController)
                .environment(\.theme, Theme.resolve(themeController.mode, systemIsDark: systemIsDark))
                .preferredColorScheme(themeController.colorSchemeOverride)
                // DF#4 foreground-reconnect: returning to `.active` (from background/
                // inactive) may find the socket silently half-open — a backgrounded WS
                // is often dropped by the OS/NAT. Revalidate so the stream + viewed
                // state revive immediately, without waiting for the keepalive deadline.
                .onChange(of: scenePhase) { old, new in
                    if new == .active && old != .active { store.revalidate() }
                }
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
