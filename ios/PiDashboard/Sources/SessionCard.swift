import SwiftUI
import PiDashboardKit

/// Status chip — colored dot + label, color via the core's `DashboardTheme.statusColor`
/// (active→green, streaming→blue, idle→muted, ended→faint). Identifier
/// `session-card-status`, accessibilityValue = the raw status (for XCUITest asserts).
struct StatusChip: View {
    let status: String?
    @Environment(\.theme) private var theme

    var body: some View {
        let label = status ?? "unknown"
        HStack(spacing: 5) {
            Circle().fill(theme.statusColor(status)).frame(width: 7, height: 7)
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(theme.statusColor(status))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(theme.statusColor(status).opacity(0.12))
        .clipShape(Capsule())
        .accessibilityIdentifier("session-card-status")
        .accessibilityValue(label)
    }
}

/// Context-window usage bar (contextTokens / contextWindow). Tints amber→red as it
/// fills. Identifier `session-card-context-bar`. Hidden when usage is unknown.
struct ContextBar: View {
    let session: DashboardSession
    @Environment(\.theme) private var theme

    var body: some View {
        if let frac = session.contextFraction {
            VStack(alignment: .leading, spacing: 3) {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(theme.bgSurface)
                        Capsule().fill(fillColor(frac))
                            .frame(width: max(4, geo.size.width * frac))
                    }
                }
                .frame(height: 4)
                if let pct = Format.contextPercent(session) {
                    Text("\(pct) context")
                        .font(.caption2)
                        .foregroundStyle(theme.textTertiary)
                }
            }
            .accessibilityIdentifier("session-card-context-bar")
            .accessibilityValue(Format.contextPercent(session) ?? "")
        }
    }

    private func fillColor(_ frac: Double) -> Color {
        switch frac {
        case ..<0.7: return theme.accentGreen
        case ..<0.9: return theme.accentYellow
        default: return theme.accentRed
        }
    }
}

/// A session card — the dashboard's row, adapted to a tappable native card. Shows
/// display name, status chip, model + thinking, context bar, git branch, unread
/// stripe, driver progress + next-engagement badge, last-activity relative time.
struct SessionCard: View {
    let session: DashboardSession
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 0) {
            // Unread stripe — left edge, present only when unread.
            if session.unread == true {
                Rectangle()
                    .fill(theme.accentBlue)
                    .frame(width: 3)
                    .accessibilityIdentifier("session-card-unread")
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    Text(session.displayName)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(theme.textPrimary)
                        .lineLimit(1)
                        .accessibilityIdentifier("session-card-name")
                    Spacer(minLength: 8)
                    StatusChip(status: session.status)
                }

                if let model = Format.modelLabel(session) {
                    Text(model)
                        .font(.caption)
                        .foregroundStyle(theme.textSecondary)
                        .lineLimit(1)
                        .accessibilityIdentifier("session-card-model")
                }

                ContextBar(session: session)

                if session.progress != nil || session.nextEngagement != nil {
                    driverRow
                }

                HStack(spacing: 10) {
                    if let branch = session.gitBranch, !branch.isEmpty {
                        Label(branch, systemImage: "arrow.triangle.branch")
                            .font(.caption2)
                            .foregroundStyle(theme.textTertiary)
                            .lineLimit(1)
                    }
                    Spacer()
                    let age = Format.relativeAge(fromEpochMs: max(session.lastActivityAt ?? 0, session.startedAt ?? 0))
                    if !age.isEmpty {
                        Text(age).font(.caption2).foregroundStyle(theme.textTertiary)
                    }
                }
            }
            .padding(12)
        }
        .background(theme.bgTertiary)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(theme.borderPrimary, lineWidth: 1)
        )
        .accessibilityIdentifier("session-card-\(session.id)")
    }

    @ViewBuilder private var driverRow: some View {
        HStack(spacing: 8) {
            if let progress = session.progress {
                HStack(spacing: 6) {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(theme.bgSurface)
                            Capsule().fill(theme.accentPurple)
                                .frame(width: max(3, geo.size.width * min(max(progress.pct, 0), 1)))
                        }
                    }
                    .frame(width: 56, height: 4)
                    if let label = progress.label {
                        Text(label).font(.caption2).foregroundStyle(theme.textSecondary).lineLimit(1)
                    } else {
                        Text("\(Int((progress.pct * 100).rounded()))%")
                            .font(.caption2).foregroundStyle(theme.textSecondary)
                    }
                }
            }
            Spacer(minLength: 0)
            if let next = session.nextEngagement {
                Text(Format.engagementLabel(next.effort))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(theme.accentOrange)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(theme.accentOrange.opacity(0.14))
                    .clipShape(Capsule())
            }
        }
    }
}
