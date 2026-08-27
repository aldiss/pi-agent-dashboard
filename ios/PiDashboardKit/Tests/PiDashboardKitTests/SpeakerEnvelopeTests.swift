import XCTest
@testable import PiDashboardKit

/// The `<speaker …>` envelope must never reach a chat bubble, and a server echo
/// that arrives wrapped must reconcile against the unwrapped optimistic row
/// instead of appending a second bubble.
///
/// Both failures were observed together on build 1: the operator's own message
/// rendered twice — once as he typed it, once as raw envelope XML with the auth
/// nonce visible.
final class SpeakerEnvelopeTests: XCTestCase {

    /// Verbatim from the operator's screenshot (nonce included) — the real shape,
    /// not a reconstruction.
    private let wrapped = """
    <speaker id="v.drobkov@gmail.com" name="aldiss" nonce="b0b175aa-6dc2-41f9-b89a-c53be6dbd258">
    this is fine of it takes slme time
    </speaker nonce="b0b175aa-6dc2-41f9-b89a-c53be6dbd258">
    """
    private let body = "this is fine of it takes slme time"
    private let nonce = "b0b175aa-6dc2-41f9-b89a-c53be6dbd258"

    // MARK: strip

    func testStripsRealOperatorEnvelopeLeavingOnlyTheBody() {
        XCTAssertEqual(SpeakerEnvelope.stripForDisplay(wrapped), body)
    }

    /// The nonce-bearing CLOSE tag is the specific thing a naive `</speaker>`
    /// strip misses — it would leave `nonce="…"` rendering in the bubble.
    func testRemovesTheNonceBearingCloseTag() {
        let out = SpeakerEnvelope.stripForDisplay(wrapped)
        XCTAssertFalse(out.contains(nonce), "the auth nonce must never survive to render")
        XCTAssertFalse(out.lowercased().contains("speaker"), "no tag remnant")
    }

    /// The security property, asserted directly rather than implied by the cases:
    /// no input shape may leak a nonce. Malformed, partial, multiple and nested
    /// envelopes included — over-stripping is preferred to leaking.
    func testNonceNeverSurvivesAnyEnvelopeShape() {
        let shapes = [
            wrapped,
            // malformed open: no `>` before the newline
            "<speaker id=\"x\" nonce=\"\(nonce)\"\n\(body)\n</speaker nonce=\"\(nonce)\">",
            // newline BEFORE nonce — the PWA regex stops at this newline and leaks
            // the entire nonce-bearing remainder. The scanner must consume through `>`.
            "<speaker id=\"x\"\nnonce=\"\(nonce)\">\(body)\n</speaker>",
            // quoted `>` BEFORE nonce — a non-quote-aware scanner stops early and leaks.
            "<speaker id=\"x>\" nonce=\"\(nonce)\">\(body)</speaker nonce=\"\(nonce)\">",
            // malformed close at end-of-input, no `>`
            "<speaker nonce=\"\(nonce)\">\n\(body)\n</speaker nonce=\"\(nonce)\"",
            // two envelopes in one message
            "\(wrapped)\n\(wrapped)",
            // nested
            "<speaker nonce=\"\(nonce)\">\(wrapped)</speaker nonce=\"\(nonce)\">",
            // uppercase tag
            "<SPEAKER ID=\"x\" NONCE=\"\(nonce)\">\n\(body)\n</SPEAKER NONCE=\"\(nonce)\">",
            // attribute-less
            "<speaker>\n\(body)\n</speaker>",
            // stray nonce-bearing close only
            "a</speaker nonce=\"\(nonce)\">b",
            // partial open mid-line, no close
            "text <speaker id=\"i\" name=\"n\" nonce=\"\(nonce)\"> mid",
            // partial open at end-of-input, no `>`
            "before\n<speaker id=\"x\" name=\"y\" nonce=\"\(nonce)\"",
        ]
        for shape in shapes {
            let out = SpeakerEnvelope.stripForDisplay(shape)
            XCTAssertFalse(out.contains(nonce), "nonce leaked from: \(shape)")
            XCTAssertFalse(out.lowercased().contains("<speaker"), "open tag survived: \(shape)")
            XCTAssertFalse(out.lowercased().contains("</speaker"), "close tag survived: \(shape)")
        }
    }

    /// Ordinary messages must pass through byte-identical — the overwhelming
    /// majority of content, and the fast path.
    func testLeavesOrdinaryContentUntouched() {
        for plain in ["", "just a message", "code with <div> and </div>",
                      "a < b and c > d", "speaker notes without a tag"] {
            XCTAssertEqual(SpeakerEnvelope.stripForDisplay(plain), plain)
        }
    }

    /// Strip only the envelope's own line breaks. Preserve body formatting.
    func testPreservesBodyNewlines() {
        let input = "<speaker nonce=\"\(nonce)\">\nline1\nline2\n</speaker nonce=\"\(nonce)\">"
        XCTAssertEqual(SpeakerEnvelope.stripForDisplay(input), "line1\nline2")
    }

    /// CRLF is one Swift Character, not two. The scanner must remove the envelope
    /// CRLF without skipping body characters or backing past the string boundary.
    func testHandlesCRLFWithoutCorruptingBody() {
        let wrappedCRLF = "<speaker nonce=\"\(nonce)\">\r\nbody\r\n</speaker nonce=\"\(nonce)\">"
        XCTAssertEqual(SpeakerEnvelope.stripForDisplay(wrappedCRLF), "body")
        let leadingCRLF = "\r\n<speaker nonce=\"\(nonce)\">body</speaker>"
        XCTAssertEqual(SpeakerEnvelope.stripForDisplay(leadingCRLF), "body")
    }

    // MARK: reconcile

    func testReconcileKeyMatchesWrappedEchoToUnwrappedOptimisticRow() {
        XCTAssertEqual(SpeakerEnvelope.reconcileKey(wrapped),
                       SpeakerEnvelope.reconcileKey(body),
                       "the wrapped echo and the typed text must reconcile as the same message")
    }

    /// End-to-end through the real reducer: an optimistic bubble, then the
    /// server's echo of the SAME message arriving wrapped. Before the fix this
    /// appended a second bubble containing the envelope; the reducer compared
    /// raw text, which can never match once the wrap is applied.
    func testWrappedServerEchoConfirmsOptimisticRowInsteadOfDuplicating() {
        var state = ChatSessionState()
        state = state.appendingOptimisticUser(text: body, timestamp: 1, nonce: "n1")
        XCTAssertEqual(state.messages.count, 1)
        XCTAssertEqual(state.messages[0].delivery, .pending)

        // Server echo with NO queueNonce (so the nonce path can't fire) and the
        // body wrapped — exactly the case that produced the doubled bubble.
        // Shape matches the real wire payload: message.{role,content}.
        let echo = DashboardEvent(
            eventType: "message_start", timestamp: 2,
            data: ["message": .object(["role": .string("user"), "content": .string(wrapped)])])
        state = state.reduce(echo)

        XCTAssertEqual(state.messages.count, 1, "must confirm in place, not append a second bubble")
        XCTAssertEqual(state.messages[0].delivery, .confirmed)
        XCTAssertEqual(state.messages[0].content, body,
                       "confirming the optimistic row must keep the clean typed body")
    }

    /// On replay there is no optimistic row, so reducer preserves the authoritative
    /// wrapped content. Rendering must strip it without mutating replay state.
    func testReplayedWrappedMessageKeepsStoredContentButHasNonceFreeDisplay() {
        let echo = DashboardEvent(
            eventType: "message_start", timestamp: 2,
            data: ["message": .object(["role": .string("user"), "content": .string(wrapped)])])
        let state = ChatSessionState().reduce(echo)
        XCTAssertEqual(state.messages.count, 1)
        XCTAssertTrue(state.messages[0].content.contains(nonce), "reducer preserves authoritative replay")
        XCTAssertEqual(SpeakerEnvelope.stripForDisplay(state.messages[0].content), body)
    }

    /// A wrapped echo can arrive after the delivery deadline has marked the clean
    /// optimistic row failed. It must recover that row rather than append a duplicate.
    func testLateWrappedEchoRecoversFailedOptimisticRow() {
        var state = ChatSessionState()
            .appendingOptimisticUser(text: body, timestamp: 1, nonce: "n1")
            .markingOptimisticFailed(nonce: "n1")
        let echo = DashboardEvent(
            eventType: "message_start", timestamp: 2,
            data: ["message": .object(["role": .string("user"), "content": .string(wrapped)])])
        state = state.reduce(echo)
        XCTAssertEqual(state.messages.count, 1)
        XCTAssertEqual(state.messages[0].delivery, .confirmed)
        XCTAssertEqual(state.messages[0].content, body)
    }

    /// The phantom "1 queued": a confirmed queued card is cleared when its dispatch
    /// echo arrives. The echo arrives WRAPPED, so a raw-text comparison never
    /// matched and the badge could stick at "1 queued" indefinitely.
    func testWrappedDispatchEchoClearsTheConfirmedQueuedCard() {
        var state = ChatSessionState()
        state.queued = [QueuedMessage(queueNonce: "q1", text: body, status: .confirmed)]
        let echo = DashboardEvent(
            eventType: "message_start", timestamp: 2,
            data: ["message": .object(["role": .string("user"), "content": .string(wrapped)])])
        state = state.reduce(echo)
        XCTAssertEqual(state.queued.count, 0, "the wrapped echo must clear its queued card")
        XCTAssertEqual(state.activeQueuedCount, 0, "badge must not stick at '1 queued'")
    }
}
