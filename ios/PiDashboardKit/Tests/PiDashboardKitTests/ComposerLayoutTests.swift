import XCTest
@testable import PiDashboardKit

/// Tests for the adaptive composer layout rule — the explicitly-named North Star
/// UX (MobileComposer.tsx @ dda5919). Verifies the asymmetric hysteresis has no
/// flip-flop pocket and the height clamp / canSend gates match the PWA.
final class ComposerLayoutTests: XCTestCase {

    func testNewlineAlwaysMultiline() {
        XCTAssertTrue(ComposerLayout.isMultiline(previous: false, text: "a\nb", contentHeight: 0))
        XCTAssertTrue(ComposerLayout.isMultiline(previous: true, text: "a\nb", contentHeight: 0))
    }

    func testShortLineStaysSingleRowEvenIfMeasuredTall() {
        // ≤20 chars, no newline → single row regardless of measured height.
        XCTAssertFalse(ComposerLayout.isMultiline(previous: false, text: "short", contentHeight: 999))
    }

    func testEnterColumnRequiresWrapAndLength() {
        let long = String(repeating: "x", count: 25)
        // long + wrapped (sh > 45) → enters column.
        XCTAssertTrue(ComposerLayout.isMultiline(previous: false, text: long, contentHeight: 50))
        // long but not wrapped (sh ≤ 45) → stays single row.
        XCTAssertFalse(ComposerLayout.isMultiline(previous: false, text: long, contentHeight: 40))
        // wrapped but short (≤20) → stays single row.
        XCTAssertFalse(ComposerLayout.isMultiline(previous: false, text: "0123456789", contentHeight: 99))
    }

    func testStaysColumnByLengthAlone_noFlipFlopPocket() {
        let long = String(repeating: "x", count: 25)
        // once column, STAY column by length alone (no height re-measure).
        XCTAssertTrue(ComposerLayout.isMultiline(previous: true, text: long, contentHeight: 0))
        // revert only when length drops to ≤20.
        XCTAssertFalse(ComposerLayout.isMultiline(previous: true, text: String(repeating: "x", count: 20), contentHeight: 999))
        // entry-floor and revert-floor share 20 → at exactly 21 chars wrapped it enters,
        // and once in, 21 chars keeps it — no oscillation.
        XCTAssertTrue(ComposerLayout.isMultiline(previous: false, text: String(repeating: "x", count: 21), contentHeight: 46))
        XCTAssertTrue(ComposerLayout.isMultiline(previous: true, text: String(repeating: "x", count: 21), contentHeight: 0))
    }

    func testClampedHeight() {
        XCTAssertEqual(ComposerLayout.clampedHeight(text: "", measured: 999), 36)
        XCTAssertEqual(ComposerLayout.clampedHeight(text: "x", measured: 10), 36)   // floor
        XCTAssertEqual(ComposerLayout.clampedHeight(text: "x", measured: 500), 200) // ceiling
        XCTAssertEqual(ComposerLayout.clampedHeight(text: "x", measured: 80), 80)   // mid-band
    }

    func testCanSend() {
        XCTAssertFalse(ComposerLayout.canSend(text: "   ", imageCount: 0, disabled: false)) // whitespace only
        XCTAssertTrue(ComposerLayout.canSend(text: "hi", imageCount: 0, disabled: false))
        XCTAssertTrue(ComposerLayout.canSend(text: "", imageCount: 1, disabled: false))     // image-only
        XCTAssertFalse(ComposerLayout.canSend(text: "hi", imageCount: 1, disabled: true))   // disabled
    }

    // MARK: resolvedWrapWidth (composer overflow — wrap to the SwiftUI-proposed width)

    func testResolvedWrapWidthPrefersFinitePositiveProposal() {
        // The width SwiftUI is constraining the field to wins → the text wraps to it.
        XCTAssertEqual(ComposerLayout.resolvedWrapWidth(proposed: 320, current: 999), 320)
    }

    func testResolvedWrapWidthFallsBackToCurrentWhenProposalUnusable() {
        // .infinity / 0 / NaN / nil proposals (the off-screen-overflow trigger) fall back
        // to the current bounds width instead of sizing to the huge intrinsic width.
        XCTAssertEqual(ComposerLayout.resolvedWrapWidth(proposed: .infinity, current: 300), 300)
        XCTAssertEqual(ComposerLayout.resolvedWrapWidth(proposed: 0, current: 300), 300)
        XCTAssertEqual(ComposerLayout.resolvedWrapWidth(proposed: .nan, current: 300), 300)
        XCTAssertEqual(ComposerLayout.resolvedWrapWidth(proposed: nil, current: 300), 300)
        XCTAssertEqual(ComposerLayout.resolvedWrapWidth(proposed: -50, current: 300), 300)
    }

    func testResolvedWrapWidthNilWhenNoUsableWidth() {
        // Neither a usable proposal nor usable bounds → nil (keep the prior size).
        XCTAssertNil(ComposerLayout.resolvedWrapWidth(proposed: nil, current: 0))
        XCTAssertNil(ComposerLayout.resolvedWrapWidth(proposed: .infinity, current: 0))
        XCTAssertNil(ComposerLayout.resolvedWrapWidth(proposed: 0, current: -1))
    }
}
