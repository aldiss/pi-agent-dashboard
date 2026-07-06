import SwiftUI
import PiDashboardKit

/// Status chip — colored dot + label sharing ONE semantic hue per session state
/// (active/idle→green, streaming→amber, ended→faint, error→red), via the core's
/// `sessionAccent`. Identifier `session-card-status`, accessibilityValue = the raw
/// status (for XCUITest asserts).
struct StatusChip: View {
    let session: DashboardSession
    @Environment(\.theme) private var theme

    var body: some View {
        let label = session.status ?? "unknown"
        let accent = theme.sessionAccent(session)
        HStack(spacing: 5) {
            Circle().fill(accent).frame(width: 7, height: 7)
                .accessibilityHidden(true) // color-only dot; the label below carries the meaning
            Text(label)
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)       // vitals-line: the status WORD in caps (visual only —
                                            // accessibilityValue below stays the raw status for XCUITest)
                .tracking(0.4)              // slight letterspacing so the uppercase word reads as a label
                .foregroundStyle(accent)
                .lineLimit(1)               // long status truncates horizontally…
                .truncationMode(.tail)      // …instead of wrapping one-char-per-line
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(accent.opacity(0.12))
        .clipShape(Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityIdentifier("session-card-status")
        // Non-color cue (Cluster 5): VoiceOver speaks the state as a word ("Working" /
        // "Idle" / "Ended" / "Waiting for your input") — not just a coloured dot. Raw
        // status stays as the a11y value for the XCUITest asserts.
        .accessibilityLabel("Status: \(A11yStatus.statusLabel(session.status, currentTool: session.currentTool))")
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
                        .font(.caption2.monospacedDigit())  // tabular figures — column-locked in the vitals line
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

/// Animated card state-pulse — the at-a-glance signature. A subtle tint overlay
/// whose hue is the pulse kind (needs-input→purple, working→amber, unread→cyan)
/// and whose opacity gently breathes. Honors Reduce Motion: when set, the tint is
/// a static low-alpha wash (no animation). `.none` renders nothing.
struct CardPulseOverlay: View {
    let kind: CardPulseKind
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    var body: some View {
        if let tint = theme.pulseAccent(kind) {
            tint
                .opacity(reduceMotion ? 0.06 : (breathing ? 0.10 : 0.04))
                .animation(reduceMotion ? nil
                           : .easeInOut(duration: 1.6).repeatForever(autoreverses: true),
                           value: breathing)
                .onAppear { if !reduceMotion { breathing = true } }
                .allowsHitTesting(false)
        }
    }
}

/// A session card — the dashboard's row, adapted to a tappable native card. Shows
/// display name, status chip, model + thinking, context bar, git branch, unread
/// stripe, driver progress + next-engagement badge, last-activity relative time.
struct SessionCard: View {
    let session: DashboardSession
    @Environment(\.theme) private var theme
    @Environment(DashboardStore.self) private var store

    private var pulseKind: CardPulseKind { DashboardTheme.cardPulseKind(session) }

    var body: some View {
        HStack(spacing: 0) {
            // Status rail — left-edge accent sharing the card's one semantic hue
            // (green alive / amber working / faint ended). Carries the unread
            // identifier when there is unviewed activity (XCUITest marker); the
            // calm-state id stays OUTSIDE the `session-card-` namespace so the
            // qa-e2e card-counter (`sessionCardIdentifiers`) never miscounts it.
            Rectangle()
                .fill(theme.sessionAccent(session))
                .frame(width: 4)
                .accessibilityIdentifier(session.unread == true ? "session-card-unread" : "card-status-rail")

            // 3-zone banding (BUILD-4): the grouping differential IS the hierarchy —
            // inter-band spacing 12 separates the three zones; intra-band 4-6 binds the
            // rows inside each. Identity reads first, then the vitals line, then the
            // receding detail. (Was one flat VStack(spacing: 8) — every row a peer.)
            VStack(alignment: .leading, spacing: 12) {

                // ── Zone 1 · IDENTITY — name + unread badge, model/thinking below.
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .top) {
                        Text(session.displayName)
                            .font(.headline)   // system font — Fraunces DEFERRED to the type-voice unit
                            .foregroundStyle(theme.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .layoutPriority(1) // truncate the name before pushing the badge off
                            .accessibilityIdentifier("session-card-name")
                        Spacer(minLength: 8)
                        unreadAsksBadge
                    }

                    if let model = Format.modelLabel(session) {
                        Text(model)
                            .font(.caption)
                            .foregroundStyle(theme.textSecondary)
                            .lineLimit(1)
                            .accessibilityIdentifier("session-card-model")
                    }
                }

                // ── Zone 2 · VITALS LINE — the uppercase status word (semantic hue) +
                // the context gauge, column-locked on one row. StatusChip + ContextBar
                // already carry the hue/data; composed here so state reads at a glance.
                vitalsRow

                // ── Zone 3 · DETAIL — driver telemetry, processes, branch/age, resume;
                // low-contrast, receding. Bound at intra-band 6 (< the 12 inter-band).
                VStack(alignment: .leading, spacing: 6) {
                    statsRow

                    if session.progress != nil || session.nextEngagement != nil {
                        driverRow
                    }

                    processList

                    gitAndAgeRow

                    resumeRow
                }
            }
            .padding(12)
        }
        .background(theme.bgTertiary)
        .background(CardPulseOverlay(kind: pulseKind))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        // Lit-from-above depth (BUILD-4 / §1.5): a vertical gradient hairline — a warm
        // highlight on the TOP edge (as if catching overhead light) fading to the flat
        // borderPrimary down the card. `strokeBorder` keeps the 1pt line inside the
        // clipped bounds. (Portico render-verifies at 393×852; if it reads glassy, the
        // fallback is a flat borderSecondary hairline.)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [Color(hex: "rgba(242,233,222,0.09)"), theme.borderPrimary],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    lineWidth: 1
                )
        )
        // Cluster 4: the card is a dense multi-row layout (name+chip, stats, badges,
        // process rows). Cap its Dynamic Type so it stays legible + unbroken at
        // accessibility sizes; body prose elsewhere (chat) still scales freely.
        .dynamicTypeCap(.cardTitle)
        // Cluster 5: combine the noisy children (name / chip / model / stats / badges /
        // process rows) into ONE VoiceOver element with a concise composed label, so
        // the card reads as a unit instead of a spammy list. `.combine` keeps the
        // resume button reachable as a nested action.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(cardAccessibilityLabel)
    }

    /// Zone-2 vitals line: the status chip (uppercase word in the semantic hue) and the
    /// context gauge on ONE row, column-locked. A long status truncates (its own
    /// `lineLimit(1)`) before crowding the gauge; the gauge takes the trailing space.
    /// Status stays leading + BELOW the name (StatusRowUITests asserts the geometry).
    @ViewBuilder private var vitalsRow: some View {
        HStack(alignment: .center, spacing: 10) {
            StatusChip(session: session)
            ContextBar(session: session)
        }
    }

    /// Concise VoiceOver summary of the card: name, spoken status, unread asks.
    private var cardAccessibilityLabel: String {
        var parts = [session.displayName,
                     A11yStatus.statusLabel(session.status, currentTool: session.currentTool)]
        let unread = store.unreadTierACount(session.id)
        if unread > 0 { parts.append("\(unread) unread \(unread == 1 ? "ask" : "asks")") }
        if let model = Format.modelLabel(session) { parts.append(model) }
        return parts.joined(separator: ", ")
    }

    // MARK: stats row (tokens + cost) — compact, alongside the context bar above

    @ViewBuilder private var statsRow: some View {
        let tokens = StatsFormat.totalTokensCompact(in: session.tokensIn, out: session.tokensOut)
        let cost = StatsFormat.cost(session.cost)
        if tokens != nil || cost != nil {
            HStack(spacing: 10) {
                if let tokens {
                    Label(tokens, systemImage: "number")
                        .font(.caption2)
                        .foregroundStyle(theme.textTertiary)
                        .accessibilityIdentifier("card-tokens")
                }
                if let cost {
                    Label(cost, systemImage: "dollarsign.circle")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(theme.accentGreen)
                        .accessibilityIdentifier("card-cost")
                }
                Spacer(minLength: 0)
            }
            .labelStyle(.titleAndIcon)
        }
    }

    // MARK: process list (display-only, capped) — child processes from the scanner

    /// Max process rows shown inline before collapsing the rest into a "+N more"
    /// line. Keeps a busy session's card compact. DISPLAY-ONLY — no kill action.
    private static let maxProcessRows = 3

    @ViewBuilder private var processList: some View {
        if let procs = session.processes, !procs.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(procs.prefix(Self.maxProcessRows)) { proc in
                    HStack(spacing: 6) {
                        Image(systemName: "gearshape").font(.system(size: 9)).foregroundStyle(theme.textTertiary)
                        Text(StatsFormat.truncateCommand(proc.command, maxLen: 30))
                            .font(.caption2.monospaced())
                            .foregroundStyle(theme.textSecondary)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(StatsFormat.elapsed(proc.elapsedMs))
                            .font(.caption2)
                            .foregroundStyle(theme.textTertiary)
                    }
                }
                if procs.count > Self.maxProcessRows {
                    Text("+\(procs.count - Self.maxProcessRows) more")
                        .font(.caption2)
                        .foregroundStyle(theme.textTertiary)
                }
            }
            .padding(.leading, 2)
            .accessibilityIdentifier("card-process-list")
        }
    }

    // MARK: git badge + PR + last-activity age

    @ViewBuilder private var gitAndAgeRow: some View {
        HStack(spacing: 8) {
            if let branch = session.gitBranch, !branch.isEmpty {
                badge(icon: "arrow.triangle.branch", text: branch, tint: theme.accentBlue)
                    .accessibilityIdentifier("card-git-branch")
                if let pr = session.gitPrNumber {
                    badge(icon: "arrow.triangle.pull", text: "#\(pr)", tint: theme.accentPurple)
                        .accessibilityIdentifier("card-git-pr")
                }
            }
            Spacer(minLength: 0)
            let age = Format.relativeAge(fromEpochMs: max(session.lastActivityAt ?? 0, session.startedAt ?? 0))
            if !age.isEmpty {
                Text(age).font(.caption2).foregroundStyle(theme.textTertiary)
            }
        }
    }

    /// A compact tinted chip (icon + label) — the card's meta-badge shape, reusing
    /// the shared semantic accents (color batch 1).
    private func badge(icon: String, text: String, tint: Color) -> some View {
        Label(text, systemImage: icon)
            .font(.caption2.weight(.medium))
            .foregroundStyle(tint)
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(tint.opacity(0.14))
            .clipShape(Capsule())
    }

    /// Engagement-weighted unread badge (DF#3): the count of Tier-A asks (ask_user /
    /// confirm / select) that arrived since the operator last read — NOT the raw
    /// message count. Cyan (the unread-pulse hue) so it ties to the card's unread
    /// state. Hidden when zero (a tool-call flood is not "unread").
    @ViewBuilder private var unreadAsksBadge: some View {
        let count = store.unreadTierACount(session.id)
        if count > 0 {
            HStack(spacing: 3) {
                Image(systemName: "bell.badge.fill").font(.system(size: 9))
                Text("\(count)").font(.caption2.weight(.bold))
            }
            .foregroundStyle(theme.statusUnread)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(theme.statusUnread.opacity(0.16))
            .clipShape(Capsule())
            .accessibilityIdentifier("card-unread-asks-\(session.id)")
            .accessibilityLabel("\(count) unread asks")
        }
    }

    // MARK: resume (ended-only control) — the app's second control action

    /// Resume affordance shown ONLY on an ended session (the server rejects
    /// `resume_session{continue}` unless status == "ended"). Tap → `store.resume`;
    /// reflects the optimistic + server-truth "Resuming…" state until the respawn
    /// registers. Green accent (reuses color-1 statusActive — a session coming back
    /// to life). a11y ids use the `card-` prefix so the qa-e2e session-card- counter
    /// is never miscounted.
    @ViewBuilder private var resumeRow: some View {
        if session.status == "ended" {
            HStack {
                Spacer(minLength: 0)
                if store.isResuming(session.id) {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.mini).tint(theme.statusActive)
                        Text("Resuming…").font(.caption2).foregroundStyle(theme.statusActive)
                    }
                    .accessibilityIdentifier("card-resume-pending")
                } else {
                    Button {
                        Task { await store.resume(session.id) }
                    } label: {
                        Label("Resume", systemImage: "play.circle")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(theme.statusActive)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 3)
                            .background(theme.statusActive.opacity(0.14))
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.pressable)
                    .accessibilityIdentifier("card-resume-button")
                }
            }
        }
    }

    @ViewBuilder private var driverRow: some View {
        HStack(spacing: 8) {
            if let progress = session.progress {
                HStack(spacing: 6) {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(theme.bgSurface)
                            Capsule().fill(progressFill)
                                .frame(width: max(3, geo.size.width * min(max(progress.pct, 0), 1)))
                        }
                    }
                    .frame(width: 56, height: 4)
                    if let label = progress.label {
                        Text(label).font(.caption2).foregroundStyle(theme.textSecondary).lineLimit(1)
                    } else {
                        Text("\(Int((progress.pct * 100).rounded()))%")
                            .font(.caption2.monospacedDigit()).foregroundStyle(theme.textSecondary)
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

    /// Progress-bar fill hue. Per the card spec, progress is NOT purple unless the
    /// session's STATE is genuinely a purple one (needs-YOU / ask_user). A generic
    /// progress bar reading purple falsely signals "awaiting input", so the default is
    /// a neutral, receding `textTertiary`; purple is reserved for the `.needsInput`
    /// pulse state (single-sourced off the same `cardPulseKind` the overlay uses).
    private var progressFill: Color {
        pulseKind == .needsInput ? theme.statusNeedsInput : theme.textTertiary
    }
}
