import Foundation

/// Hermetic UI-test fixtures — the SHARED CONTRACT between the app and the qa-e2e
/// XCUITests (`hermetic-fixtures-brief.md`). Lives in `PiDashboardKit` so BOTH sides
/// import the SAME stable constants (zero drift): the app injects `sessions` +
/// `chat(for:)` when launched with `launchArg`, and the tests assert against the exact
/// ids/names/statuses here.
///
/// Why: the CI e2e run TIMED OUT waiting 60–114 s per test on LIVE-dashboard elements
/// that don't exist on a serverless runner. With `-uitest-fixtures` the app boots
/// straight into a populated, deterministic list marked "connected" — no network — so
/// the suite is fast + green on CI and locally.
///
/// The fixture set is engineered to satisfy all 10 UITest files at once:
///  - Folding      — 7 sessions across ≥4 cwds and 3 tiers (standing-crew/drivers/other).
///  - CrewCollapse — "Pete" has tenures in TWO cwds → folds to ONE standing-crew row +1.
///  - StatusRow    — `fix-longstatus` carries a long status string (chip truncation).
///  - Color/Status — idle / streaming / ended (+ an error-flagged tool in the chat).
///  - Chat/ReadPosition/ModelPicker/Separation — `fix-pete` has a multi-message
///    `chat(for:)` (user + assistant + tool call) and `unread == true`.
///  - CardRichness — `fix-pete` carries gitBranch + process list + token/cost stats.
public enum UITestFixtures {

    /// The launch argument the app detects (`ProcessInfo.processInfo.arguments`) to
    /// enter hermetic fixture mode. The qa-e2e base case adds this to `launchArguments`.
    public static let launchArg = "-uitest-fixtures"

    // Stable ids the qa-e2e tests assert against — NEVER rename without updating both sides.
    public static let peteId = "fix-pete"            // standing-crew survivor (cwd A), rich card + chat
    public static let peteSecondId = "fix-pete-2"    // standing-crew Pete tenure (cwd B) → folds into peteId +1
    public static let cartographerId = "fix-cartographer" // drivers tier, streaming
    public static let keystoneId = "fix-keystone"    // drivers tier, idle
    public static let longStatusId = "fix-longstatus" // long status string (chip-truncation test)
    public static let endedId = "fix-atlas"          // ended (color/status test)
    public static let voyageId = "fix-voyage"        // other tier, idle, firstMessage-only (no name)

    /// Fixed base clock (epoch-ms) — a CONSTANT, not `Date.now`, so the fixtures are
    /// fully deterministic across runs (the tests can reason about relative recency).
    /// 2026-06-01T00:00:00Z.
    public static let baseTime: Double = 1_780_272_000_000

    // Two cwds Pete has tenures in — the cross-cwd crew-collapse fixture.
    public static let cwdOrchestration = "/Users/op/.pi/orchestration-state"
    public static let cwdUnend = "/private/tmp/unend-e2e-cwd"
    public static let cwdArchDriver = "/Users/op/.pi/orchestration-state/nos-cells/arch-diagram-driver"
    public static let cwdAuthDriver = "/Users/op/.pi/orchestration-state/nos-cells/auth-build-driver"
    public static let cwdVoyage = "/Users/op/Misc/Documents/Copilot/voyage-poc"

    /// The stable fixture sessions injected into the store. Order is the natural
    /// server order; grouping/folding/collapse are applied by the app's pure helpers.
    public static var sessions: [DashboardSession] {
        let t = baseTime

        // ── standing-crew: Pete, TWO tenures in TWO cwds → collapse to one row +1 ──
        // Survivor (most-recent) — the RICH card: git + processes + stats + unread + chat.
        var pete = DashboardSession(id: peteId, cwd: cwdOrchestration, name: "Pete",
                                    source: "tmux", status: "streaming",
                                    startedAt: t - 3_600_000, lastActivityAt: t - 20_000)
        pete.model = "anthropic/claude-opus-4"; pete.thinkingLevel = "high"
        pete.contextTokens = 128_000; pete.contextWindow = 200_000
        pete.gitBranch = "feat/native-ios-tests"; pete.gitPrNumber = 42
        pete.tokensIn = 182_400; pete.tokensOut = 24_800; pete.cost = 1.87
        pete.unread = true
        pete.currentTool = "bash"
        pete.processes = [
            ProcessEntry(pid: 4821, pgid: 4821, command: "swift test", elapsedMs: 42_000),
            ProcessEntry(pid: 4822, pgid: 4821, command: "xcodebuild -scheme PiDashboard", elapsedMs: 12_500),
        ]

        // Older Pete tenure in a DIFFERENT cwd — the "+1" that folds into the survivor.
        var peteOld = DashboardSession(id: peteSecondId, cwd: cwdUnend, name: "Pete",
                                       source: "tmux", status: "ended",
                                       startedAt: t - 9_000_000, lastActivityAt: t - 7_200_000)
        peteOld.model = "anthropic/claude-sonnet-4"
        peteOld.endedAt = t - 7_200_000

        // ── drivers tier (tmux under nos-cells/) — streaming + idle ──
        var cartographer = DashboardSession(id: cartographerId, cwd: cwdArchDriver,
                                            name: "Cartographer", source: "tmux", status: "streaming",
                                            startedAt: t - 7_200_000, lastActivityAt: t - 5_000)
        cartographer.model = "anthropic/claude-sonnet-4"; cartographer.thinkingLevel = "medium"
        cartographer.contextTokens = 152_000; cartographer.contextWindow = 200_000
        cartographer.gitBranch = "feat/native-ios-app"
        cartographer.progress = DriverProgress(pct: 0.62, label: "wiring composer", milestonesDone: 5, milestonesTotal: 8)
        cartographer.nextEngagement = DriverNextEngagement(effort: "one-action", note: "approve plan")

        var keystone = DashboardSession(id: keystoneId, cwd: cwdAuthDriver,
                                        name: "Keystone", source: "tmux", status: "idle",
                                        startedAt: t - 9_000_000, lastActivityAt: t - 1_200_000)
        keystone.model = "anthropic/claude-opus-4"
        keystone.contextTokens = 41_000; keystone.contextWindow = 200_000
        keystone.gitBranch = "main"
        keystone.progress = DriverProgress(pct: 0.25, label: "scoping", milestonesDone: 1, milestonesTotal: 4)
        keystone.nextEngagement = DriverNextEngagement(effort: "back-and-forth", note: "design review")

        // ── long status (chip truncation — StatusRow test) ──
        var longStatus = DashboardSession(id: longStatusId, cwd: cwdOrchestration,
                                          name: "Longwind", source: "tmux",
                                          status: "running an extremely long-winded diagnostic sweep across every subsystem",
                                          startedAt: t - 2_400_000, lastActivityAt: t - 15_000)
        longStatus.model = "anthropic/claude-sonnet-4"
        longStatus.contextTokens = 60_000; longStatus.contextWindow = 200_000

        // ── ended (color/status test) ──
        var atlas = DashboardSession(id: endedId, cwd: cwdOrchestration,
                                     name: "Atlas", source: "tmux", status: "ended",
                                     startedAt: t - 5_400_000, lastActivityAt: t - 4_900_000)
        atlas.model = "anthropic/claude-haiku-4"; atlas.endedAt = t - 4_900_000

        // ── other tier (tmux, no name, firstMessage-only, idle) ──
        var voyage = DashboardSession(id: voyageId, cwd: cwdVoyage, name: nil,
                                      source: "tmux", status: "idle",
                                      startedAt: t - 14_400_000, lastActivityAt: t - 3_000_000)
        voyage.firstMessage = "Investigate the voyage embeddings latency regression\nand propose a fix"
        voyage.model = "anthropic/claude-sonnet-4"
        voyage.contextTokens = 33_000; voyage.contextWindow = 200_000

        return [pete, peteOld, cartographer, keystone, longStatus, atlas, voyage]
    }

    /// Per-cwd server order — pins Pete's survivor first in the orchestration group.
    public static var orders: [String: [String]] {
        [cwdArchDriver: [cartographerId]]
    }

    /// Pinned directories — the orchestration root (folder-fold + pin-badge coverage).
    public static var pinned: [String] { [cwdOrchestration] }

    /// The scripted chat for a session — a multi-message transcript (user + assistant
    /// prose + a tool call with args and a multi-line result) reduced through the REAL
    /// `ChatSessionState.reduce` (faithful, not faked), so ChatView / read-position /
    /// model-picker / message-separation all have real rows to assert against. Only
    /// `peteId` has a scripted chat; any other id → an empty state (renders the loader).
    public static func chat(for id: String) -> ChatSessionState {
        guard id == peteId else { return ChatSessionState() }
        func ev(_ type: String, _ data: [String: JSONValue], _ ts: Double) -> DashboardEvent {
            DashboardEvent(eventType: type, timestamp: ts, data: data)
        }
        let assistantMarkdown = """
        ## Hermetic fixtures

        Wiring the e2e suite to deterministic data. Steps:

        1. Add `UITestFixtures` to the core
        2. Inject on `-uitest-fixtures`
        3. Assert against stable ids like `fix-pete`

        Inline `chat(for:)` returns the reduced state.
        """
        let toolResult = """
        Test Suite 'All tests' started
        Executed 414 tests, with 0 failures (0 unexpected) in 0.20s
        ** TEST SUCCEEDED **
        """
        let events: [DashboardEvent] = [
            ev("message_start", ["message": .object(["role": .string("user"),
                "content": .string("Make the e2e suite hermetic with injected fixtures.")])], baseTime + 1),
            ev("agent_start", [:], baseTime + 2),
            ev("message_update", ["assistantMessageEvent": .object(["type": .string("thinking_start")])], baseTime + 3),
            ev("message_update", ["assistantMessageEvent": .object([
                "type": .string("thinking_delta"),
                "delta": .string("Share the fixture constants in PiDashboardKit so both the app and the tests import one source of truth — zero drift.")])], baseTime + 4),
            ev("message_update", ["assistantMessageEvent": .object(["type": .string("thinking_end")])], baseTime + 8),
            ev("message_start", ["message": .object(["role": .string("assistant")])], baseTime + 9),
            ev("message_update", ["message": .object(["role": .string("assistant"),
                "content": .array([.object(["type": .string("text"), "text": .string(assistantMarkdown)])])])], baseTime + 10),
            ev("tool_execution_start", ["toolCallId": .string("t1"), "toolName": .string("bash"),
                "args": .object(["command": .string("swift test"), "cwd": .string("ios/PiDashboardKit")])], baseTime + 11),
            ev("tool_execution_end", ["toolCallId": .string("t1"),
                "result": .string(toolResult), "isError": .bool(false)], baseTime + 17),
            ev("message_end", ["message": .object(["role": .string("assistant"),
                "content": .array([
                    .object(["type": .string("text"), "text": .string(assistantMarkdown)]),
                    .object(["type": .string("toolCall"), "id": .string("t1")]),
                ])])], baseTime + 18),
            ev("stats_update", ["turnUsage": .object([
                "input": .number(8200), "output": .number(540),
                "cacheRead": .number(64000), "cacheWrite": .number(1200)]),
                "contextUsage": .object(["tokens": .number(128000), "contextWindow": .number(200000)])], baseTime + 19),
        ]
        return ChatSessionState().reduce(events: events)
    }
}
