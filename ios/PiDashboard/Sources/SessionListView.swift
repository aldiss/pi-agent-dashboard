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

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    toggleChip("Folders", isOn: store.folders, id: "toggle-folders") { store.folders.toggle() }
                    toggleChip("Hide ended", isOn: store.hideEnded, id: "toggle-hide-ended") { store.hideEnded.toggle() }
                    toggleChip("Hide stale", isOn: store.hideStale, id: "toggle-hide-stale") { store.hideStale.toggle() }
                }
                HStack(spacing: 8) {
                    toggleChip("Active only", isOn: store.activeOnly, id: "toggle-active-only") { store.activeOnly.toggle() }
                    toggleChip("Hidden", isOn: store.showHidden, id: "toggle-show-hidden") { store.showHidden.toggle() }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
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
        let collapsedGroups = SessionGrouping.collapseGroups(
            section.groups, selectedId: store.viewedSessionId)
        let collapsedGroupIDs = Set(collapsedGroups
            .filter { !store.isDirExpanded($0.cwd) }
            .map(\.id))
        let directoryLabelIDs = SessionGrouping.rowsNeedingDirectoryLabel(collapsedGroups)
        let count = collapsedGroups.reduce(0) { $0 + $1.rows.count }
        let expanded = store.isTierExpanded(section.tier)
        return Section {
            if expanded {
                ForEach(collapsedGroups) { group in
                    directoryGroup(group, directoryLabelIDs: directoryLabelIDs,
                                   collapsedGroupIDs: collapsedGroupIDs)
                }
            }
        } header: {
            tierHeader(section.tier, count: count, expanded: expanded)
        }
    }

    /// Foldable tier header (PWA-style): a tappable row that folds/unfolds the tier's
    /// groups — mirrors `directoryHeader`. Leading chevron (down = expanded, right =
    /// collapsed), the tier label, and the count badge (ALWAYS visible, even collapsed).
    /// Fold state persists per tier.rawValue (store.tierFold); force-expanded on search.
    private func tierHeader(_ tier: SessionTier, count: Int, expanded: Bool) -> some View {
        Button {
            store.toggleTier(tier)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(theme.textTertiary)
                    .frame(width: 10)
                Text(tierLabel(tier))
                    .font(.subheadline.weight(.bold))
                    .dynamicTypeCap(.sectionHeader)
                    .foregroundStyle(theme.textSecondary)
                Text("\(count)")
                    .font(.caption2)
                    .foregroundStyle(theme.textTertiary)
                Spacer()
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.bgPrimary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("tier-section-\(tier.rawValue)")
        .accessibilityLabel("\(expanded ? "Collapse" : "Expand") \(tierLabel(tier))")
        .accessibilityValue(expanded ? "expanded" : "collapsed")
    }

    @ViewBuilder private func directoryGroup(
        _ group: SessionGrouping.CollapsedDirectoryGroup,
        directoryLabelIDs: Set<String>,
        collapsedGroupIDs: Set<SessionGrouping.CollapsedDirectoryGroup.ID>
    ) -> some View {
        let hasHeader = store.folders && !group.cwd.isEmpty
        let expanded = !collapsedGroupIDs.contains(group.id)
        let visibleRows = SessionGrouping.visibleRows(
            in: [group], collapsedGroupIDs: collapsedGroupIDs)
        VStack(alignment: .leading, spacing: 8) {
            if hasHeader {
                directoryHeader(group, expanded: expanded)
            }
            ForEach(visibleRows) { collapsed in
                VStack(alignment: .leading, spacing: 8) {
                    NavigationLink {
                        ChatView(sessionId: collapsed.session.id, title: collapsed.session.displayName)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            SessionCard(session: collapsed.session)
                            if directoryLabelIDs.contains(collapsed.session.id) {
                                Text(directoryBasename(for: collapsed.session))
                                    .font(.caption2)
                                    .foregroundStyle(theme.textTertiary)
                                    .lineLimit(1)
                                    .padding(.horizontal, 12)
                                    .accessibilityIdentifier("card-directory-label-\(collapsed.session.id)")
                            }
                        }
                    }
                    .buttonStyle(.pressableCard)
                    .accessibilityIdentifier("session-card-\(collapsed.session.id)")
                    .overlay(alignment: .topTrailing) {
                        if collapsed.olderCount > 0 {
                            foldToggle(collapsed)
                        }
                    }

                    if store.expandedFoldedRows.contains(collapsed.session.id) {
                        ForEach(SessionGrouping.foldedSessions(
                            collapsed, registry: store.sessions
                        )) { session in
                            NavigationLink {
                                ChatView(sessionId: session.id, title: session.displayName)
                            } label: {
                                SessionCard(session: session)
                            }
                            .buttonStyle(.pressableCard)
                            .accessibilityIdentifier("session-card-\(session.id)")
                            .padding(.leading, 16)
                        }
                    }
                }
            }
        }
    }

    private func foldToggle(_ collapsed: SessionGrouping.CollapsedSession) -> some View {
        let expanded = store.expandedFoldedRows.contains(collapsed.session.id)
        return ZStack {
            Button {
                store.toggleFoldedRow(collapsed.session.id)
            } label: {
                Text("+\(collapsed.olderCount)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(theme.textSecondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(theme.bgSurface)
                    .clipShape(Capsule())
                    .overlay(Capsule().stroke(theme.borderPrimary, lineWidth: 1))
                    .padding(6)
                    .frame(minWidth: 44, minHeight: 44, alignment: .topTrailing)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("card-collapsed-toggle-\(collapsed.session.id)")
            .accessibilityLabel(
                "\(expanded ? "Hide" : "Show") \(collapsed.olderCount) older \(collapsed.session.displayName) tenures")
            .accessibilityValue(expanded ? "expanded" : "collapsed")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("card-collapsed-count-\(collapsed.session.id)")
    }

    private func directoryBasename(for session: DashboardSession) -> String {
        let path = SessionGrouping.groupPath(session)
        return path.split(separator: "/").last.map(String.init) ?? path
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
        .buttonStyle(.pressable)
        .accessibilityIdentifier("dir-group-\(group.basename)")
        .accessibilityLabel("\(expanded ? "Collapse" : "Expand") \(group.basename)")
        .accessibilityAddTraits(.isHeader)
        .contextMenu {
            if let action = DirectoryPinAction.resolve(cwd: group.cwd, pinned: group.pinned) {
                Button {
                    Task {
                        switch action {
                        case .pin:
                            await store.pinDirectory(group.cwd)
                        case .unpin:
                            await store.unpinDirectory(group.cwd)
                        }
                    }
                } label: {
                    Label(action == .pin ? "Pin folder" : "Unpin folder",
                          systemImage: action == .pin ? "pin" : "pin.slash")
                }
                .accessibilityIdentifier("dir-pin-toggle-\(group.basename)")
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
