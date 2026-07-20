import SwiftUI
import PiDashboardKit

/// Connect screen — server URL (default the tunnel) + **Sign in with GitHub** (the
/// multi-operator OAuth cookie gate), health-probe Connect, known-server quick-connect.
/// Identifiers per TEST-CONTRACT §A: connect-server-url / connect-signin-github /
/// connect-submit / connect-error / connect-health / known-server-row-<host>. (The old
/// connect-token bearer field is removed — the WS gate is cookie-only.)
struct ConnectView: View {
    @Environment(DashboardStore.self) private var store
    @Environment(AuthManager.self) private var auth
    @Environment(\.theme) private var theme

    @State private var knownServers: [KnownServer] = KnownServersStore.load()
    @State private var connecting = false
    @State private var signingIn = false

    var body: some View {
        @Bindable var store = store
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header

                VStack(alignment: .leading, spacing: 14) {
                    field(title: "Server URL") {
                        TextField("https://dash.deckdeckshare.com", text: $store.serverURLString)
                            .textContentType(.URL)
                            .keyboardType(.URL)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .accessibilityIdentifier("connect-server-url")
                    }

                    authRow

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
                .font(.system(.largeTitle, design: .rounded).weight(.bold))
                .dynamicTypeCap(.title)
                .foregroundStyle(theme.textPrimary)
            Text("Connect to a running dashboard server.")
                .font(.callout)
                .foregroundStyle(theme.textSecondary)
        }
        .padding(.top, 28)
    }

    /// Sign-in affordance: a "Sign in with GitHub" button when signed out, or the
    /// signed-in operator identity (name/email) + Sign out when authenticated. The WS
    /// gate is cookie-only, so signing in is what makes Connect actually succeed.
    @ViewBuilder private var authRow: some View {
        if auth.isLoggedIn {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.seal.fill").foregroundStyle(theme.accentGreen)
                VStack(alignment: .leading, spacing: 1) {
                    Text(signedInName).font(.callout.weight(.medium)).foregroundStyle(theme.textPrimary)
                    if let email = auth.user?.email, email != signedInName {
                        Text(email).font(.caption2).foregroundStyle(theme.textTertiary).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                Button("Sign out") { auth.signOut() }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(theme.accentBlue)
                    .accessibilityIdentifier("connect-signout")
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.bgTertiary)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityIdentifier("connect-signed-in")
        } else {
            Button(action: signIn) {
                HStack(spacing: 8) {
                    if signingIn { ProgressView().tint(theme.textPrimary) }
                    else { Image(systemName: "person.badge.key.fill") }
                    Text(signingIn ? "Signing in…" : "Sign in with GitHub")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(theme.bgTertiary)
                .foregroundStyle(theme.textPrimary)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(theme.textTertiary.opacity(0.25), lineWidth: 1))
            }
            .disabled(signingIn)
            .accessibilityIdentifier("connect-signin-github")
        }
    }

    private var signedInName: String {
        auth.user?.name ?? auth.user?.email ?? "Signed in"
    }

    @ViewBuilder private var errorBanner: some View {
        if let message = bannerMessage {
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

    /// The connect-error surfaces a failed connect phase OR an auth sign-in error.
    private var bannerMessage: String? {
        if case .failed(let message) = store.phase { return message }
        return auth.lastError
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

    /// Kick off GitHub OAuth. On success the cookie is captured to the Keychain and we
    /// auto-connect (the operator's intent was to reach the dashboard). A cancel / the
    /// empty-cookie STOP surfaces via `auth.lastError` in the error banner.
    private func signIn() {
        signingIn = true
        Task {
            defer { signingIn = false }
            do {
                // Point the auth flow at the SAME server the app connects to (the server-URL
                // field) so sign-in + code-exchange hit the canary/prod base, not the hardcoded
                // tunnel. v4-safe (JWT via exchange body, not a domain-bound cookie).
                auth.setServer(store.serverURLString)
                try await auth.signIn()
                submit()
            } catch {
                // Surfaced via auth.lastError (set inside AuthManager) → connect-error banner.
            }
        }
    }

    private func submit() {
        connecting = true
        Task {
            await store.connect()
            connecting = false
            if case .connected = store.phase {
                let server = KnownServer(url: store.serverURLString, token: nil)
                KnownServersStore.remember(server)
                knownServers = KnownServersStore.load()
            }
        }
    }
}
