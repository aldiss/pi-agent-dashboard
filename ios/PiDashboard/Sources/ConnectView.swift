import SwiftUI
import PiDashboardKit

/// Connect screen — server URL (default localhost:8000), optional bearer token,
/// health-probe Connect, known-server quick-connect. Identifiers per TEST-CONTRACT
/// §A: connect-server-url / connect-token / connect-submit / connect-error /
/// connect-health / known-server-row-<host>.
struct ConnectView: View {
    @Environment(DashboardStore.self) private var store
    @Environment(\.theme) private var theme

    @State private var knownServers: [KnownServer] = KnownServersStore.load()
    @State private var connecting = false

    var body: some View {
        @Bindable var store = store
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header

                VStack(alignment: .leading, spacing: 14) {
                    field(title: "Server URL") {
                        TextField("http://localhost:8000", text: $store.serverURLString)
                            .textContentType(.URL)
                            .keyboardType(.URL)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .accessibilityIdentifier("connect-server-url")
                    }
                    field(title: "Bearer token (optional)") {
                        SecureField("token", text: $store.token)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .accessibilityIdentifier("connect-token")
                    }

                    Button(action: submit) {
                        HStack {
                            if connecting { ProgressView().tint(.black) }
                            Text(connecting ? "Connecting…" : "Connect")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(theme.textPrimary)
                        .foregroundStyle(theme.bgPrimary)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .disabled(connecting || store.serverURLString.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("connect-submit")
                }

                errorBanner
                healthReadout
                knownServersSection
            }
            .padding(20)
        }
        .background(theme.bgPrimary)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("pi dashboard")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(theme.textPrimary)
            Text("Connect to a running dashboard server.")
                .font(.callout)
                .foregroundStyle(theme.textSecondary)
        }
        .padding(.top, 28)
    }

    @ViewBuilder private var errorBanner: some View {
        if case .failed(let message) = store.phase {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                Text(message).font(.footnote)
            }
            .foregroundStyle(theme.accentRed)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.accentRed.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityIdentifier("connect-error")
        }
    }

    @ViewBuilder private var healthReadout: some View {
        if let h = store.health, case .connected = store.phase {
            HStack(spacing: 8) {
                Circle().fill(theme.accentGreen).frame(width: 8, height: 8)
                Text("v\(h.version ?? "?") · \(h.mode ?? "?") · \(h.server?.activeSessions ?? 0) active")
                    .font(.footnote)
                    .foregroundStyle(theme.textSecondary)
            }
            .accessibilityIdentifier("connect-health")
        }
    }

    @ViewBuilder private var knownServersSection: some View {
        if !knownServers.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Known servers")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(theme.textTertiary)
                ForEach(knownServers) { server in
                    Button {
                        store.serverURLString = server.url
                        store.token = server.token ?? ""
                        submit()
                    } label: {
                        HStack {
                            Image(systemName: "server.rack").foregroundStyle(theme.textTertiary)
                            Text(server.host).foregroundStyle(theme.textPrimary)
                            Spacer()
                            Image(systemName: "arrow.up.right").foregroundStyle(theme.textTertiary).font(.caption)
                        }
                        .padding(12)
                        .background(theme.bgTertiary)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .accessibilityIdentifier("known-server-row-\(server.host)")
                }
            }
            .padding(.top, 4)
        }
    }

    private func field<Content: View>(title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption).foregroundStyle(theme.textTertiary)
            content()
                .padding(12)
                .background(theme.bgTertiary)
                .foregroundStyle(theme.textPrimary)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private func submit() {
        connecting = true
        Task {
            await store.connect()
            connecting = false
            if case .connected = store.phase {
                let server = KnownServer(url: store.serverURLString, token: store.token.isEmpty ? nil : store.token)
                KnownServersStore.remember(server)
                knownServers = KnownServersStore.load()
            }
        }
    }
}
