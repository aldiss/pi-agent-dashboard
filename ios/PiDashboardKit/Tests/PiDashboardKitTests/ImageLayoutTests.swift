import XCTest
import CoreGraphics
@testable import PiDashboardKit

/// Pins `ImageLayout.thumbnailSize` — inline chat images fit WHOLE + aspect-preserved
/// into a 200pt box (PWA `ChatView.tsx` object-contain parity), replacing the old
/// `.scaledToFill()` fixed-140²-square center-crop. RED→GREEN guard for the
/// image-resize bug: a non-square image must keep its aspect, not be forced to a square.
final class ImageLayoutTests: XCTestCase {

    func testWideImageCapsWidthKeepsAspect() {
        // 3:1 wide → width caps at 200, height follows aspect (400 * 200/1200 = 66.67).
        let s = ImageLayout.thumbnailSize(for: CGSize(width: 1200, height: 400))
        XCTAssertEqual(s.width, 200, accuracy: 0.5)
        XCTAssertEqual(s.height, 67, accuracy: 0.5)
    }

    func testTallImageCapsHeightKeepsAspect() {
        // 1:3 tall → height caps at 200, width follows aspect.
        let s = ImageLayout.thumbnailSize(for: CGSize(width: 400, height: 1200))
        XCTAssertEqual(s.width, 67, accuracy: 0.5)
        XCTAssertEqual(s.height, 200, accuracy: 0.5)
    }

    func testSquareImageFillsBound() {
        let s = ImageLayout.thumbnailSize(for: CGSize(width: 800, height: 800))
        XCTAssertEqual(s.width, 200, accuracy: 0.5)
        XCTAssertEqual(s.height, 200, accuracy: 0.5)
    }

    func testNeverUpscalesSmallImage() {
        // Below the bound → shown at natural size (scale clamped to 1).
        let s = ImageLayout.thumbnailSize(for: CGSize(width: 80, height: 60))
        XCTAssertEqual(s.width, 80, accuracy: 0.5)
        XCTAssertEqual(s.height, 60, accuracy: 0.5)
    }

    func testBothDimensionsWithinBound() {
        for src in [CGSize(width: 4000, height: 3000),
                    CGSize(width: 100, height: 5000),
                    CGSize(width: 5000, height: 100)] {
            let s = ImageLayout.thumbnailSize(for: src)
            XCTAssertLessThanOrEqual(s.width, ImageLayout.thumbnailBound)
            XCTAssertLessThanOrEqual(s.height, ImageLayout.thumbnailBound)
        }
    }

    func testDegenerateSizeFallsBackToBound() {
        let s = ImageLayout.thumbnailSize(for: CGSize(width: 0, height: 0))
        XCTAssertEqual(s.width, 200, accuracy: 0.5)
        XCTAssertEqual(s.height, 200, accuracy: 0.5)
    }

    func testAspectRatioPreservedWithinRounding() {
        let src = CGSize(width: 1200, height: 400)
        let s = ImageLayout.thumbnailSize(for: src)
        XCTAssertEqual(s.width / s.height, src.width / src.height, accuracy: 0.05)
    }

    /// The bug: the old chain forced a fixed 140×140 SQUARE for EVERY image, discarding
    /// aspect. A non-square input must now stay non-square (edges preserved).
    func testNonSquareIsNotForcedToSquare() {
        let s = ImageLayout.thumbnailSize(for: CGSize(width: 1200, height: 400))
        XCTAssertNotEqual(s.width, s.height)
    }
}
