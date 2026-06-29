import Foundation
import PiDashboardKit

/// Bundled fixtures for the UITest launch path (`-uitest`). Lets the smoke suite
/// drive ConnectView → list → chat → composer hermetically — no live server, no
/// risk of mutating an operator session (brief §4). Shapes mirror the real
/// `sessions_snapshot` + reduced chat; built by feeding synthetic events through
/// the SAME `ChatSessionState.reduce` the live path uses (faithful, not faked).
enum FixtureData {
    struct Snapshot {
        let sessions: [DashboardSession]
        let orders: [String: [String]]
        let pinned: [String]
    }

    /// A spread of sessions covering tiers + card states (status / context / git /
    /// unread / driver progress + next-engagement).
    static func sessionsSnapshot() -> Snapshot {
        let now = Date().timeIntervalSince1970 * 1000

        var joan = DashboardSession(id: "fix-joan", cwd: "/Users/op/.pi/orchestration-state",
                                    name: "Joan", source: "tui", status: "active", startedAt: now - 3_600_000,
                                    lastActivityAt: now - 30_000)
        joan.model = "anthropic/claude-opus-4"; joan.thinkingLevel = "high"
        joan.contextTokens = 84_000; joan.contextWindow = 200_000
        joan.gitBranch = "main"; joan.unread = true

        var driver = DashboardSession(id: "fix-cartographer", cwd: "/Users/op/.pi/orchestration-state/nos-cells/arch-diagram-driver",
                                      name: "Cartographer", source: "tmux", status: "streaming", startedAt: now - 7_200_000,
                                      lastActivityAt: now - 5_000)
        driver.model = "anthropic/claude-sonnet-4"; driver.thinkingLevel = "medium"
        driver.contextTokens = 152_000; driver.contextWindow = 200_000
        driver.gitBranch = "feat/native-ios-app"
        driver.progress = DriverProgress(pct: 0.62, label: "wiring composer", milestonesDone: 5, milestonesTotal: 8)
        driver.nextEngagement = DriverNextEngagement(effort: "one-action", note: "approve plan")

        var driver2 = DashboardSession(id: "fix-keystone", cwd: "/Users/op/.pi/orchestration-state/nos-cells/auth-build-driver",
                                       name: "Keystone", source: "tmux", status: "idle", startedAt: now - 9_000_000,
                                       lastActivityAt: now - 1_200_000)
        driver2.model = "anthropic/claude-opus-4"
        driver2.contextTokens = 41_000; driver2.contextWindow = 200_000
        driver2.gitBranch = "main"
        driver2.progress = DriverProgress(pct: 0.25, label: "scoping", milestonesDone: 1, milestonesTotal: 4)
        driver2.nextEngagement = DriverNextEngagement(effort: "back-and-forth", note: "design review")

        var cell = DashboardSession(id: "fix-mintowl", cwd: "/Users/op/.pi/cells/mobile-composer/v1",
                                    name: "MintOwl", source: "tmux", status: "active", startedAt: now - 1_800_000,
                                    lastActivityAt: now - 12_000)
        cell.model = "anthropic/claude-sonnet-4"
        cell.contextTokens = 96_000; cell.contextWindow = 200_000
        cell.gitBranch = "cell/mobile-composer"

        var pane = DashboardSession(id: "fix-scratch", cwd: "/Users/op/Misc/Documents/Copilot/pi-agent-dashboard",
                                    name: "Scratch", source: "tui", status: "active", startedAt: now - 600_000,
                                    lastActivityAt: now - 8_000)
        pane.model = "anthropic/claude-opus-4"; pane.thinkingLevel = "low"
        pane.contextTokens = 12_000; pane.contextWindow = 200_000
        pane.gitBranch = "feat/native-ios-app"

        var worker = DashboardSession(id: "fix-worker", cwd: "/Users/op/Misc/Documents/Copilot/pi-agent-dashboard",
                                      name: "subagent-worker-3f4a9c", source: "tmux", status: "ended",
                                      startedAt: now - 5_400_000, lastActivityAt: now - 4_900_000)
        worker.model = "anthropic/claude-haiku-4"
        worker.endedAt = now - 4_900_000

        var other = DashboardSession(id: "fix-voyage", cwd: "/Users/op/Misc/Documents/Copilot/voyage-poc",
                                     name: nil, source: "tmux", status: "idle", startedAt: now - 14_400_000,
                                     lastActivityAt: now - 3_000_000)
        other.firstMessage = "Investigate the voyage embeddings latency regression\nand propose a fix"
        other.model = "anthropic/claude-sonnet-4"
        other.contextTokens = 33_000; other.contextWindow = 200_000

        let sessions = [joan, driver, driver2, cell, pane, worker, other]
        let orders: [String: [String]] = [
            "/Users/op/.pi/orchestration-state/nos-cells/arch-diagram-driver": ["fix-cartographer"],
        ]
        let pinned = ["/Users/op/.pi/orchestration-state"]
        return Snapshot(sessions: sessions, orders: orders, pinned: pinned)
    }

    /// A scripted chat reduced through the real reducer — user prompt, thinking,
    /// assistant text, a tool call+result, and turn stats. Renders every row kind.
    static func chatState() -> ChatSessionState {
        func ev(_ type: String, _ data: [String: JSONValue], _ ts: Double) -> DashboardEvent {
            DashboardEvent(eventType: type, timestamp: ts, data: data)
        }
        let events: [DashboardEvent] = [
            ev("message_start", ["message": .object(["role": .string("user"),
                "content": .string("Port the mobile composer to native SwiftUI")])], 1),
            ev("agent_start", [:], 2),
            ev("message_update", ["assistantMessageEvent": .object(["type": .string("thinking_start")])], 3),
            ev("message_update", ["assistantMessageEvent": .object([
                "type": .string("thinking_delta"),
                "delta": .string("The hysteresis rule lives in ComposerLayout — reuse it.")])], 4),
            ev("message_update", ["assistantMessageEvent": .object(["type": .string("thinking_end")])], 9),
            ev("message_start", ["message": .object(["role": .string("assistant")])], 10),
            ev("message_update", ["message": .object(["role": .string("assistant"),
                "content": .array([.object(["type": .string("text"),
                    "text": .string("I'll wire the native composer to `ComposerLayout.isMultiline`. Running a check first:")])])])], 11),
            ev("tool_execution_start", ["toolCallId": .string("t1"), "toolName": .string("bash"),
                "args": .object(["command": .string("swift test")])], 12),
            ev("tool_execution_end", ["toolCallId": .string("t1"),
                "result": .string("Executed 50 tests, with 0 failures"), "isError": .bool(false)], 18),
            ev("message_end", ["message": .object(["role": .string("assistant"),
                "content": .array([
                    .object(["type": .string("text"), "text": .string("I'll wire the native composer to `ComposerLayout.isMultiline`. Running a check first:")]),
                    .object(["type": .string("toolCall"), "id": .string("t1")]),
                ])])], 19),
            ev("stats_update", ["turnUsage": .object([
                "input": .number(8200), "output": .number(540),
                "cacheRead": .number(64000), "cacheWrite": .number(1200)]),
                "contextUsage": .object(["tokens": .number(84000), "contextWindow": .number(200000)])], 20),
        ]
        return ChatSessionState().reduce(events: events)
    }
}
