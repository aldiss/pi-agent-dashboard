import SwiftUI
import PiDashboardKit

/// Session list — search + toggles + tier sections, each with directory subgroups,
/// each card a NavigationLink into the chat. Identifiers per TEST-CONTRACT §A.
struct SessionListView: View {
    @Environment(DashboardStore.self) private var store
    @Environment(\.theme) private var theme

    var body: some View {
        @Bindable var store = store
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16, pinnedViews: [.sectionHeaders]) {
                controls

                if store.totalVisibleCount == 0 {
                    emptyState
                } else {
                    ForEach(store.tierSections) { section in
                        tierSection(section)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .accessibilityIdentifier("session-list")
        .background(theme.bgPrimary)
        .scrollDismissesKeyboard(.interactively)
    }

    // MARK: controls

    private var controls: some View {
        @Bindable var store = store
        return VStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(theme.textTertiary)
                TextField("Search sessions", text: $store.search)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .foregroundStyle(theme.textPrimary)
                    .accessibilityIdentifier("list-search")
                if !store.search.isEmpty {
                    Button { store.search = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(theme.textTertiary)
                    }
                }
            }
            .padding(10)
            .background(theme.bgTertiary)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    toggleChip("Folders", isOn: store.folders, id: "toggle-folders") { store.folders.toggle() }
                    toggleChip("Hide ended", isOn: store.hideEnded, id: "toggle-hide-ended") { store.hideEnded.toggle() }
                    toggleChip("Hide stale", isOn: store.hideStale, id: "toggle-hide-stale") { store.hideStale.toggle() }
                    toggleChip("Hidden", isOn: store.showHidden, id: "toggle-show-hidden") { store.showHidden.toggle() }
                }
            }
        }
    }

    private func toggleChip(_ label: String, isOn: Bool, id: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundStyle(isOn ? theme.bgPrimary : theme.textSecondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(isOn ? theme.accentBlue : theme.bgTertiary)
                .clipShape(Capsule())
        }
        .accessibilityIdentifier(id)
        .accessibilityValue(isOn ? "on" : "off")
    }

    // MARK: tier section

    private func tierSection(_ section: TierSection) -> some View {
        Section {
            ForEach(section.groups, id: \.cwd) { group in
                directoryGroup(group)
            }
        } header: {
            HStack(spacing: 8) {
                Text(tierLabel(section.tier))
                    .font(.subheadline.weight(.bold))
                    .dynamicTypeCap(.sectionHeader)
                    .foregroundStyle(theme.textSecondary)
                Text("\(section.groups.reduce(0) { $0 + $1.sessions.count })")
                    .font(.caption2)
                    .foregroundStyle(theme.textTertiary)
                Spacer()
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.bgPrimary)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("tier-section-\(section.tier.rawValue)")
        }
    }

    @ViewBuilder private func directoryGroup(_ group: SessionGrouping.DirectoryGroup) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if store.folders && !group.cwd.isEmpty {
                HStack(spacing: 5) {
                    Image(systemName: group.pinned ? "pin.fill" : "folder")
                        .font(.caption2)
                        .foregroundStyle(group.pinned ? theme.accentBlue : theme.textTertiary)
                    Text(group.basename)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(theme.textTertiary)
                        .lineLimit(1)
                }
                .padding(.horizontal, 4)
                .accessibilityIdentifier("dir-group-\(group.basename)")
            }
            ForEach(SessionGrouping.collapseSameName(group.sessions, selectedId: store.viewedSessionId)) { collapsed in
                NavigationLink {
                    ChatView(sessionId: collapsed.session.id, title: collapsed.session.displayName)
                } label: {
                    SessionCard(session: collapsed.session)
                        .overlay(alignment: .topTrailing) {
                            if collapsed.olderCount > 0 {
                                Text("+\(collapsed.olderCount)")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(theme.textSecondary)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(theme.bgSurface)
                                    .clipShape(Capsule())
                                    .overlay(Capsule().stroke(theme.borderPrimary, lineWidth: 1))
                                    .padding(6)
                                    .accessibilityIdentifier("card-collapsed-count-\(collapsed.session.id)")
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("session-card-\(collapsed.session.id)")
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "tray").font(.largeTitle).foregroundStyle(theme.textTertiary)
            Text(store.search.isEmpty ? "No sessions" : "No matches")
                .foregroundStyle(theme.textSecondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 80)
        .accessibilityIdentifier("session-list-empty")
    }

    private func tierLabel(_ tier: SessionTier) -> String {
        switch tier {
        case .standingCrew: return "Standing Crew"
        case .drivers: return "Drivers"
        case .cellExecutor: return "Cell Executors"
        case .operatorChatPane: return "Operator Chat"
        case .worker: return "Workers"
        case .other: return "Other"
        }
    }
}
