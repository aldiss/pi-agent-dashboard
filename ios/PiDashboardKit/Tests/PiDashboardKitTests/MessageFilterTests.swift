import XCTest
@testable import PiDashboardKit

/// Message-type filter (operator-priority): the 6-category classifier + filter pass
/// (native adaptation of the PWA `message-filter-classifier.ts`) plus the reducer
/// suppression that kills the empty `turn_start` / raw-lifecycle rows. All pure —
/// verified via `swift test`, no simulator.
final class MessageFilterTests: XCTestCase {

    private func msg(_ role: ChatRole, toolName: String? = nil) -> ChatMessage {
        ChatMessage(id: "\(role)-\(toolName ?? "")", role: role, content: "x",
                    toolName: toolName, timestamp: 0)
    }

    // MARK: classifier (role → category)

    func testToolRowsClassifyAsToolCalls() {
        XCTAssertEqual(MessageClassifier.classify(msg(.toolResult, toolName: "bash")), .toolCalls)
        XCTAssertEqual(MessageClassifier.classify(msg(.bashOutput)), .toolCalls)
        XCTAssertEqual(MessageClassifier.classify(msg(.commandFeedback)), .toolCalls)
    }

    /// ask_user is the operator-direct ask — surfaces natively as a `.toolResult`
    /// whose toolName is "ask_user" → tierA (NOT toolCalls). This is how the native
    /// role model expresses the PWA `interactiveUi`/tierA case.
    func testAskUserClassifiesAsTierA() {
        XCTAssertEqual(MessageClassifier.classify(msg(.toolResult, toolName: "ask_user")), .tierA)
    }

    /// thinking / turnSeparator / rawEvent → systemNotifications (hidden by default).
    /// NOTE: thinking→systemNotifications follows the OPERATOR BRIEF (the PWA source
    /// currently uses tierB). See MessageClassifier doc-comment.
    func testSystemNotificationRoles() {
        XCTAssertEqual(MessageClassifier.classify(msg(.thinking)), .systemNotifications)
        XCTAssertEqual(MessageClassifier.classify(msg(.turnSeparator)), .systemNotifications)
        XCTAssertEqual(MessageClassifier.classify(msg(.rawEvent, toolName: "turn_start")), .systemNotifications)
    }

    func testUserAssistantAreMeshChatter() {
        XCTAssertEqual(MessageClassifier.classify(msg(.user)), .meshChatter)
        XCTAssertEqual(MessageClassifier.classify(msg(.assistant)), .meshChatter)
    }

    // MARK: defaults

    func testDefaultFilterHidesToolAndSystemAndLedger() {
        let d = MessageFilter.default
        XCTAssertTrue(d.tierA); XCTAssertTrue(d.tierB); XCTAssertTrue(d.meshChatter)
        XCTAssertFalse(d.toolCalls, "tool calls OFF by default")
        XCTAssertFalse(d.systemNotifications, "system notes OFF by default")
        XCTAssertFalse(d.tierC, "ledger OFF by default")
        XCTAssertTrue(d.isDefault)
        XCTAssertFalse(d.isAllOn)
    }

    func testIsDefaultDetectsDivergence() {
        XCTAssertTrue(MessageFilter.default.isDefault)
        XCTAssertFalse(MessageFilter.default.setting(.toolCalls, true).isDefault)
        XCTAssertTrue(MessageFilter.default.setting(.toolCalls, true).setting(.toolCalls, false).isDefault)
    }

    func testSettingAndIsOnRoundTrip() {
        let f = MessageFilter.default.setting(.systemNotifications, true)
        XCTAssertTrue(f.isOn(.systemNotifications))
        XCTAssertFalse(f.isOn(.toolCalls))
    }

    // MARK: filter pass

    /// With the DEFAULT filter a mixed transcript keeps user/assistant/ask_user and
    /// drops tool rows + thinking + raw lifecycle — the clean-by-default chat.
    func testDefaultFilterProducesCleanChat() {
        let messages = [
            msg(.user), msg(.assistant),
            msg(.toolResult, toolName: "bash"),   // toolCalls — hidden
            msg(.thinking),                        // systemNotifications — hidden
            msg(.rawEvent, toolName: "turn_start"),// systemNotifications — hidden
            msg(.toolResult, toolName: "ask_user"),// tierA — KEPT
        ]
        let shown = MessageClassifier.filter(messages, .default)
        XCTAssertEqual(shown.count, 3, "user + assistant + ask_user survive")
        XCTAssertTrue(shown.allSatisfy { $0.role == .user || $0.role == .assistant
            || ($0.role == .toolResult && $0.toolName == "ask_user") })
    }

    /// All-on filter is a pass-through (no rows dropped).
    func testAllOnFilterReturnsEverything() {
        let all = MessageFilter(tierA: true, tierB: true, tierC: true,
                                meshChatter: true, toolCalls: true, systemNotifications: true)
        let messages = [msg(.user), msg(.toolResult, toolName: "bash"), msg(.thinking)]
        XCTAssertEqual(MessageClassifier.filter(messages, all).count, 3)
    }

    /// Toggling toolCalls ON reveals the tool rows on top of the default.
    func testEnablingToolCallsRevealsToolRows() {
        let messages = [msg(.user), msg(.toolResult, toolName: "bash"), msg(.bashOutput)]
        let withTools = MessageFilter.default.setting(.toolCalls, true)
        XCTAssertEqual(MessageClassifier.filter(messages, withTools).count, 3)
        XCTAssertEqual(MessageClassifier.filter(messages, .default).count, 1, "only the user row by default")
    }

    // MARK: reducer suppression (the empty-row fix)

    private func event(_ type: String) -> DashboardEvent {
        DashboardEvent(eventType: type, timestamp: 1, data: [:])
    }

    /// `turn_start` emits NO row (the primary empty-row fix at the reducer level).
    func testTurnStartEmitsNoRow() {
        let state = ChatSessionState().reduce(event("turn_start"))
        XCTAssertTrue(state.messages.isEmpty, "turn_start must not create a row")
    }

    /// `turn_created` (sibling marker) also emits no row.
    func testTurnCreatedEmitsNoRow() {
        XCTAssertTrue(ChatSessionState().reduce(event("turn_created")).messages.isEmpty)
    }

    /// `turn_end` still emits no row (unchanged behavior).
    func testTurnEndEmitsNoRow() {
        XCTAssertTrue(ChatSessionState().reduce(event("turn_end")).messages.isEmpty)
    }

    /// A GENUINELY-unknown event still emits a `.rawEvent` row (available for debug),
    /// and that row classifies as `systemNotifications` → hidden by the default
    /// filter. Belt-and-suspenders: even un-suppressed noise is hidden by default.
    func testUnknownEventStillRawButHiddenByDefault() {
        let state = ChatSessionState().reduce(event("some_new_event_type"))
        XCTAssertEqual(state.messages.count, 1, "unknown event still surfaces as raw (debuggable)")
        XCTAssertEqual(state.messages[0].role, .rawEvent)
        XCTAssertEqual(MessageClassifier.classify(state.messages[0]), .systemNotifications)
        XCTAssertTrue(MessageClassifier.filter(state.messages, .default).isEmpty,
                      "raw debug row hidden under the default filter")
    }

    // MARK: persistence (ephemeral UserDefaults — no simulator, no shared-state bleed)

    private func ephemeral() -> (UserDefaults, String) {
        let suite = "pi.dashboard.msgfilter.tests.\(UUID().uuidString)"
        return (UserDefaults(suiteName: suite)!, suite)
    }

    func testLoadFreshSessionReturnsCanonicalDefault() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        XCTAssertFalse(MessageFilterStore.hasOverride("s1", in: d))
        XCTAssertEqual(MessageFilterStore.load("s1", from: d), .default)
    }

    func testSessionOverrideRoundTrips() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        let custom = MessageFilter.default.setting(.toolCalls, true)
        MessageFilterStore.save("s1", custom, to: d)
        XCTAssertTrue(MessageFilterStore.hasOverride("s1", in: d))
        XCTAssertEqual(MessageFilterStore.load("s1", from: d), custom)
        // A different session is unaffected — per-session isolation.
        XCTAssertEqual(MessageFilterStore.load("s2", from: d), .default)
    }

    /// A fresh session with NO override resolves to the app-level default when one
    /// is set (the "new sessions start from the app default" contract).
    func testAppDefaultSeedsNewSessions() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        let appDefault = MessageFilter.default.setting(.systemNotifications, true)
        MessageFilterStore.saveDefault(appDefault, to: d)
        XCTAssertEqual(MessageFilterStore.loadDefault(from: d), appDefault)
        XCTAssertEqual(MessageFilterStore.load("brand-new", from: d), appDefault,
                       "a session with no override inherits the app default")
    }

    /// Session override wins over the app default.
    func testSessionOverrideBeatsAppDefault() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        MessageFilterStore.saveDefault(MessageFilter.default.setting(.systemNotifications, true), to: d)
        let sessionFilter = MessageFilter.default.setting(.toolCalls, true)
        MessageFilterStore.save("s1", sessionFilter, to: d)
        XCTAssertEqual(MessageFilterStore.load("s1", from: d), sessionFilter)
    }

    func testClearOverrideRevertsToDefault() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        MessageFilterStore.save("s1", MessageFilter.default.setting(.tierC, true), to: d)
        MessageFilterStore.clear("s1", from: d)
        XCTAssertFalse(MessageFilterStore.hasOverride("s1", in: d))
        XCTAssertEqual(MessageFilterStore.load("s1", from: d), .default)
    }

    /// Saving the canonical default AS the app default clears the key (clean revert).
    func testSavingCanonicalAppDefaultClearsKey() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        MessageFilterStore.saveDefault(MessageFilter.default.setting(.toolCalls, true), to: d)
        MessageFilterStore.saveDefault(.default, to: d)
        XCTAssertEqual(MessageFilterStore.loadDefault(from: d), .default)
    }
}
