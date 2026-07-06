import SwiftUI
import PiDashboardKit

/// The 6-category message-type filter pill row — native mirror of the PWA
/// `MessageFilterControls`. Controlled: the parent (`ChatView`) owns the canonical
/// `MessageFilter` + persistence; this view renders the pills + dispatches toggles.
/// Tapping a pill flips that category; "Reset" restores the canonical default; "Set
/// as default" persists the current filter as the app-level default for new sessions.
struct MessageFilterControls: View {
    let filter: MessageFilter
    let counts: [MessageCategory: Int]
    let onChange: (MessageFilter) -> Void
    let onReset: () -> Void
    let onSetDefault: () -> Void

    @Environment(\.theme) private var theme

    /// Display order + labels mirror the PWA pill row.
    private static let ordered: [(MessageCategory, String)] = [
        (.tierA, "Tier-A asks"),
        (.tierB, "Narrative"),
        (.meshChatter, "Mesh chatter"),
        (.toolCalls, "Tool calls"),
        (.systemNotifications, "System notes"),
        (.tierC, "Ledger only"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Self.ordered, id: \.0) { category, label in
                        pill(category, label)
                    }
                }
                .padding(.horizontal, 12)
            }
            HStack(spacing: 14) {
                if !filter.isDefault {
                    Button("Reset", action: onReset)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(theme.accentBlue)
                        .accessibilityIdentifier("chat-filter-reset")
                }
                Button("Set as default", action: onSetDefault)
                    .font(.caption2)
                    .foregroundStyle(theme.textTertiary)
                    .accessibilityIdentifier("chat-filter-set-default")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
        }
        .padding(.vertical, 8)
        .background(theme.bgSecondary)
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.borderPrimary).frame(height: 1)
        }
        .accessibilityIdentifier("chat-filter-controls")
    }

    private func pill(_ category: MessageCategory, _ label: String) -> some View {
        let on = filter.isOn(category)
        let count = counts[category] ?? 0
        return Button {
            onChange(filter.setting(category, !on))
        } label: {
            HStack(spacing: 5) {
                Circle()
                    .fill(on ? pillColor(category) : .clear)
                    .overlay(Circle().stroke(pillColor(category), lineWidth: on ? 0 : 1))
                    .frame(width: 6, height: 6)
                Text(label).font(.caption2.weight(.medium))
                if count > 0 {
                    Text("\(count)").font(.caption2).opacity(0.7)
                }
            }
            .foregroundStyle(on ? pillColor(category) : theme.textTertiary)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background((on ? pillColor(category) : theme.textTertiary).opacity(on ? 0.15 : 0.06))
            .clipShape(Capsule())
            .overlay(Capsule().stroke(pillColor(category).opacity(on ? 0.4 : 0.2), lineWidth: 1))
        }
        .buttonStyle(.pressable)
        .accessibilityIdentifier("chat-filter-pill-\(category.rawValue)")
        .accessibilityValue(on ? "on" : "off")
    }

    /// Per-category accent (reuses the color-1/color-2 semantic palette).
    private func pillColor(_ category: MessageCategory) -> Color {
        switch category {
        case .tierA:               return theme.statusWorking   // amber — asks
        case .tierB:               return theme.accentBlue      // narrative
        case .meshChatter:         return theme.textSecondary   // chat
        case .toolCalls:           return theme.statusActive    // green — tools
        case .systemNotifications: return theme.accentPurple    // debug/thinking
        case .tierC:               return theme.accentRed       // ledger
        }
    }
}
