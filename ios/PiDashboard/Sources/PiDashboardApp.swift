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
/// then MainView. MainView stays mounted across transient drops (the
/// ConnectionBanner reflects `.reconnecting`); only an explicit disconnect returns
/// to ConnectView.
struct RootView: View {
    @Environment(DashboardStore.self) private var store
    @Environment(\.theme) private var theme

    var body: some View {
        ZStack {
            theme.bgPrimary.ignoresSafeArea()
            if store.hasEnteredDashboard {
                MainView()
            } else {
                ConnectView()
            }
        }
    }
}
