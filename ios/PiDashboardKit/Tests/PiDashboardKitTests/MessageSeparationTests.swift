import XCTest
@testable import PiDashboardKit

/// Round 3.3 — message separation ("wall of text" fix). The layout (soft assistant
/// card, sender header, visible turn break, wider spacing) is app-layer; the pure bits
/// the view drives off — the sender label per role + which rows show the header — are
/// pinned here.
final class MessageSeparationTests: XCTestCase {

    // MARK: senderLabel

    func testSenderLabelPerRole() {
        XCTAssertEqual(ChatRender.senderLabel(for: .user), "You")
        XCTAssertEqual(ChatRender.senderLabel(for: .assistant), "Assistant")
        XCTAssertEqual(ChatRender.senderLabel(for: .thinking), "Thinking")
        XCTAssertEqual(ChatRender.senderLabel(for: .toolResult), "Tool")
        XCTAssertEqual(ChatRender.senderLabel(for: .bashOutput), "Terminal")
        XCTAssertEqual(ChatRender.senderLabel(for: .commandFeedback), "Command")
        XCTAssertEqual(ChatRender.senderLabel(for: .rawEvent), "Event")
    }

    /// A turn separator is its own break — no sender.
    func testSenderLabelNilForTurnSeparator() {
        XCTAssertNil(ChatRender.senderLabel(for: .turnSeparator))
    }

    /// Every role that shows the header MUST have a non-nil label (the view force-reads it).
    func testEveryHeaderRoleHasALabel() {
        for role in [ChatRole.user, .assistant, .thinking, .toolResult, .bashOutput, .commandFeedback, .rawEvent] {
            if ChatRender.showsSenderHeader(for: role) {
                XCTAssertNotNil(ChatRender.senderLabel(for: role), "\(role) shows a header → needs a label")
            }
        }
    }

    // MARK: showsSenderHeader

    /// Only the PROSE rows (user / assistant) get the lightweight dot+label header —
    /// they're the ones that otherwise float with no role cue.
    func testShowsSenderHeaderOnlyForProseRows() {
        XCTAssertTrue(ChatRender.showsSenderHeader(for: .user))
        XCTAssertTrue(ChatRender.showsSenderHeader(for: .assistant))
    }

    /// Card rows already carry an icon+name header (their own marker) → no second label;
    /// the turn separator is its own break.
    func testCardAndSeparatorRowsSkipTheHeader() {
        for role in [ChatRole.thinking, .toolResult, .bashOutput, .commandFeedback, .rawEvent, .turnSeparator] {
            XCTAssertFalse(ChatRender.showsSenderHeader(for: role), "\(role) must NOT show the prose sender header")
        }
    }
}
