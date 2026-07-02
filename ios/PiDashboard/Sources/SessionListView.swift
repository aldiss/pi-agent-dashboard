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
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Clear search")
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
        // Fold crew canonical names GLOBALLY across this tier's directory groups (a crew
        // name with tenures in >1 cwd was doubling — once per cwd-group). Non-crew names
        // still fold per-cwd. Groups emptied by the fold drop out.
        let collapsedGroups = SessionGrouping.collapseGroupsFoldingCrew(
            section.groups, selectedId: store.viewedSessionId)
        return Section {
            ForEach(collapsedGroups) { group in
                directoryGroup(group)
            }
        } header: {
            HStack(spacing: 8) {
                Text(tierLabel(section.tier))
                    .font(.subheadline.weight(.bold))
                    .dynamicTypeCap(.sectionHeader)
                    .foregroundStyle(theme.textSecondary)
                Text("\(collapsedGroups.reduce(0) { $0 + $1.rows.count })")
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

    @ViewBuilder private func directoryGroup(_ group: SessionGrouping.CollapsedDirectoryGroup) -> some View {
        let hasHeader = store.folders && !group.cwd.isEmpty
        let expanded = store.isDirExpanded(group.cwd)
        VStack(alignment: .leading, spacing: 8) {
            if hasHeader {
                directoryHeader(group, expanded: expanded)
            }
            if !hasHeader || expanded {
                ForEach(group.rows) { collapsed in
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
    }

    /// Foldable directory header (PWA-style): a tappable row that folds/unfolds the
    /// sessions under it. Leading chevron (down = expanded, right = collapsed), the
    /// folder/pin glyph + basename, and — when collapsed — the folded session count.
    /// Fold state persists per cwd (store.collapsedDirs). Pinned styling preserved.
    private func directoryHeader(_ group: SessionGrouping.CollapsedDirectoryGroup, expanded: Bool) -> some View {
        Button {
            store.toggleDirCollapsed(group.cwd)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(theme.textTertiary)
                    .frame(width: 10)
                Image(systemName: group.pinned ? "pin.fill" : "folder")
                    .font(.caption2)
                    .foregroundStyle(group.pinned ? theme.accentBlue : theme.textTertiary)
                Text(group.basename)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(theme.textTertiary)
                    .lineLimit(1)
                if !expanded {
                    Text("\(group.rows.count)")
                        .font(.caption2)
                        .foregroundStyle(theme.textTertiary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(theme.bgSurface)
                        .clipShape(Capsule())
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("dir-group-\(group.basename)")
        .accessibilityLabel("\(expanded ? "Collapse" : "Expand") \(group.basename)")
        .accessibilityAddTraits(.isHeader)
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
