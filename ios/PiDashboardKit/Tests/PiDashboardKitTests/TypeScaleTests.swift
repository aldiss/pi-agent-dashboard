import XCTest
@testable import PiDashboardKit

/// Cluster 4 — the pure Dynamic-Type policy: which roles cap where, the tap-target
/// floor, and the clamp math. UI-free, `swift test`-verified (the actual scaling is
/// SwiftUI; this pins the DECISIONS so a role's cap can't silently drift).
final class TypeScaleTests: XCTestCase {

    // MARK: role caps

    /// Flowing prose scales freely; dense / single-line-beside-siblings roles cap so
    /// the layout can't break at accessibility sizes.
    func testBodyIsUncappedOthersCap() {
        XCTAssertNil(TypeRole.body.dynamicTypeCapOrdinal, "chat prose scales all the way")
        XCTAssertFalse(TypeScale.isCapped(.body))
        for role in TypeRole.allCases where role != .body {
            XCTAssertNotNil(role.dynamicTypeCapOrdinal, "\(role) must cap to protect its layout")
            XCTAssertTrue(TypeScale.isCapped(role))
        }
    }

    /// A tight capsule (badge) caps SOONER than the general dense roles — it has the
    /// least room.
    func testBadgeCapsSoonerThanCardTitle() {
        let badge = TypeRole.badge.dynamicTypeCapOrdinal!
        let cardTitle = TypeRole.cardTitle.dynamicTypeCapOrdinal!
        XCTAssertLessThan(badge, cardTitle, "badge (a11y2) caps before cardTitle (a11y3)")
        XCTAssertEqual(badge, TypeScale.accessibility2)
        XCTAssertEqual(cardTitle, TypeScale.accessibility3)
    }

    /// Every cap is at least the default size (never caps BELOW default — that would
    /// regress the default layout / shrink text).
    func testNoCapBelowDefaultSize() {
        for role in TypeRole.allCases {
            if let cap = role.dynamicTypeCapOrdinal {
                XCTAssertGreaterThanOrEqual(cap, TypeScale.large,
                                            "\(role) cap must not shrink below the default size")
            }
        }
    }

    // MARK: clamp math

    func testCappedOrdinalClampsToCap() {
        // A user at accessibility5 (11) on a cardTitle (cap a11y3=9) → clamped to 9.
        XCTAssertEqual(TypeScale.cappedOrdinal(current: TypeScale.accessibility5,
                                               cap: TypeRole.cardTitle.dynamicTypeCapOrdinal), 9)
        // Below the cap → unchanged.
        XCTAssertEqual(TypeScale.cappedOrdinal(current: TypeScale.large, cap: 9), 3)
        // No cap (body) → unchanged even at the largest.
        XCTAssertEqual(TypeScale.cappedOrdinal(current: 11, cap: nil), 11)
    }

    // MARK: tap target

    func testMinTapTargetIsHIG44() {
        XCTAssertEqual(TypeScale.minTapTarget, 44, "Apple HIG minimum touch target")
    }

    // MARK: ordinal anchors are ordered (guards a typo in the constants)

    func testOrdinalAnchorsMonotonic() {
        XCTAssertLessThan(TypeScale.large, TypeScale.accessibility1)
        XCTAssertLessThan(TypeScale.accessibility1, TypeScale.accessibility2)
        XCTAssertLessThan(TypeScale.accessibility2, TypeScale.accessibility3)
        XCTAssertLessThan(TypeScale.accessibility3, TypeScale.accessibility5)
    }
}
