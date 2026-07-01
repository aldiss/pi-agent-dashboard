import SwiftUI
import PiDashboardKit

/// Settings screen (parity B5) — consolidates the app's config in one reachable
/// place: theme mode, the current connection + Change-server, the known-servers
/// list, the app-level chat-filter default, and app info. Presented as a sheet from
/// the session-list toolbar gear. DISPLAY + config only — no control actions (no git
/// checkout / no session spawn from here).
struct SettingsView: View {
    @Environment(DashboardStore.self) private var store
    @Environment(ThemeController.self) private var themeController
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss

    @State private var knownServers: [KnownServer] = KnownServersStore.load()
    @State private var chatFilterDefault: MessageFilter = MessageFilterStore.loadDefault()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    appearanceSection
                    connectionSection
                    if !knownServers.isEmpty { knownServersSection }
                    chatFilterSection
                    aboutSection
                }
                .padding(20)
            }
            .background(theme.bgPrimary)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(theme.accentBlue)
                        .accessibilityIdentifier("settings-done")
                }
            }
        }
        .accessibilityIdentifier("settings-view")
    }

    // MARK: Appearance (theme mode)

    private var appearanceSection: some View {
        section("Appearance") {
            @Bindable var controller = themeController
            VStack(alignment: .leading, spacing: 10) {
                Picker("Theme", selection: $controller.mode) {
                    ForEach(ThemeMode.allCases, id: \.self) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("settings-theme-picker")
                Text(themeHint)
                    .font(.caption2)
                    .foregroundStyle(theme.textTertiary)
            }
        }
    }

    private var themeHint: String {
        switch themeController.mode {
        case .system: return "Follows your device's light/dark setting."
        case .dark:   return "Always dark."
        case .light:  return "Always light."
        }
    }

    // MARK: Connection

    private var connectionSection: some View {
        section("Connection") {
            VStack(alignment: .leading, spacing: 12) {
                labeledRow(icon: "server.rack", label: "Server", value: store.serverURLString)
                if let h = store.health, case .connected = store.phase {
                    labeledRow(icon: "checkmark.seal", label: "Status",
                               value: "v\(h.version ?? "?") · \(h.server?.activeSessions ?? 0) active",
                               tint: theme.statusActive)
                }
                Button {
                    store.showConnectForm()
                    dismiss()
                } label: {
                    Label("Change server", systemImage: "arrow.triangle.2.circlepath")
                        .font(.callout.weight(.medium))
                        .foregroundStyle(theme.accentBlue)
                }
                .accessibilityIdentifier("settings-change-server")
            }
        }
    }

    // MARK: Known servers

    private var knownServersSection: some View {
        section("Known servers") {
            VStack(spacing: 8) {
                ForEach(knownServers) { server in
                    HStack(spacing: 10) {
                        Image(systemName: "server.rack").foregroundStyle(theme.textTertiary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(server.host).font(.callout).foregroundStyle(theme.textPrimary).lineLimit(1)
                            if server.url != server.host {
                                Text(server.url).font(.caption2).foregroundStyle(theme.textTertiary)
                                    .lineLimit(1).truncationMode(.head)
                            }
                        }
                        Spacer(minLength: 8)
                        Button {
                            KnownServersStore.remove(server.url)
                            knownServers = KnownServersStore.load()
                        } label: {
                            Image(systemName: "trash").foregroundStyle(theme.accentRed).font(.caption)
                        }
                        .accessibilityIdentifier("settings-known-server-remove-\(server.host)")
                    }
                    .padding(12)
                    .background(theme.bgTertiary)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
        }
    }

    // MARK: Chat-filter default

    private var chatFilterSection: some View {
        section("Default chat filter") {
            VStack(alignment: .leading, spacing: 10) {
                Text("What new sessions show by default. Tool calls + system notes are hidden unless enabled.")
                    .font(.caption2).foregroundStyle(theme.textTertiary)
                ForEach(filterToggleOrder, id: \.0) { category, label in
                    Toggle(isOn: bindingFor(category)) {
                        Text(label).font(.callout).foregroundStyle(theme.textPrimary)
                    }
                    .tint(theme.accentBlue)
                    .accessibilityIdentifier("settings-filter-\(category.rawValue)")
                }
                if !chatFilterDefault.isDefault {
                    Button("Reset to defaults") {
                        chatFilterDefault = .default
                        MessageFilterStore.saveDefault(.default)
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(theme.accentBlue)
                    .accessibilityIdentifier("settings-filter-reset")
                }
            }
        }
    }

    private var filterToggleOrder: [(MessageCategory, String)] {
        [(.tierA, "Tier-A asks"), (.tierB, "Narrative"), (.meshChatter, "Mesh chatter"),
         (.toolCalls, "Tool calls"), (.systemNotifications, "System notes"), (.tierC, "Ledger only")]
    }

    private func bindingFor(_ category: MessageCategory) -> Binding<Bool> {
        Binding(
            get: { chatFilterDefault.isOn(category) },
            set: { on in
                chatFilterDefault = chatFilterDefault.setting(category, on)
                MessageFilterStore.saveDefault(chatFilterDefault)
            })
    }

    // MARK: About

    private var aboutSection: some View {
        section("About") {
            VStack(alignment: .leading, spacing: 8) {
                labeledRow(icon: "app.badge", label: "Version", value: appVersion)
                labeledRow(icon: "hammer", label: "Build", value: appBuild)
                labeledRow(icon: "iphone", label: "pi dashboard", value: "native iOS client")
            }
        }
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
    }
    private var appBuild: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "—"
    }

    // MARK: building blocks

    private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(theme.textTertiary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func labeledRow(icon: String, label: String, value: String, tint: Color? = nil) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).foregroundStyle(theme.textTertiary).frame(width: 20)
            Text(label).font(.callout).foregroundStyle(theme.textSecondary)
            Spacer(minLength: 8)
            Text(value).font(.callout).foregroundStyle(tint ?? theme.textPrimary)
                .lineLimit(1).truncationMode(.middle)
        }
    }
}
