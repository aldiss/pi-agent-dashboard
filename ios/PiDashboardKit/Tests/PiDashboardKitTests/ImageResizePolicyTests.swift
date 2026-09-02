import XCTest
@testable import PiDashboardKit

final class ImageResizePolicyTests: XCTestCase {
    func testLandscapeLongEdgeIsCappedAndAspectRatioPreserved() {
        XCTAssertEqual(
            ImageResizePolicy.computeResizeDimensions(width: 4032, height: 3024),
            ImageResizeDimensions(width: 1568, height: 1176, resized: true)
        )
    }

    func testPortraitLongEdgeIsCappedAndAspectRatioPreserved() {
        XCTAssertEqual(
            ImageResizePolicy.computeResizeDimensions(width: 3024, height: 4032),
            ImageResizeDimensions(width: 1176, height: 1568, resized: true)
        )
    }

    func testSquareIsCappedOnBothEdges() {
        XCTAssertEqual(
            ImageResizePolicy.computeResizeDimensions(width: 4000, height: 4000),
            ImageResizeDimensions(width: 1568, height: 1568, resized: true)
        )
    }

    func testImageAlreadyWithinCapIsUntouched() {
        XCTAssertEqual(
            ImageResizePolicy.computeResizeDimensions(width: 1200, height: 800),
            ImageResizeDimensions(width: 1200, height: 800, resized: false)
        )
    }

    func testSmallImageIsNeverUpscaled() {
        XCTAssertEqual(
            ImageResizePolicy.computeResizeDimensions(width: 320, height: 240),
            ImageResizeDimensions(width: 320, height: 240, resized: false)
        )
    }

    func testExactlyAtCapIsUntouched() {
        XCTAssertEqual(
            ImageResizePolicy.computeResizeDimensions(width: 1568, height: 1000),
            ImageResizeDimensions(width: 1568, height: 1000, resized: false)
        )
    }

    func testShortEdgeRoundsToNearestPixel() {
        XCTAssertEqual(
            ImageResizePolicy.computeResizeDimensions(width: 1569, height: 10),
            ImageResizeDimensions(width: 1568, height: 10, resized: true)
        )
    }

    func testRoundedShortEdgeNeverFallsBelowOnePixel() {
        XCTAssertEqual(
            ImageResizePolicy.computeResizeDimensions(width: 1568, height: 0.1, maxLongEdge: 1),
            ImageResizeDimensions(width: 1, height: 1, resized: true)
        )
    }

    func testCustomMaximumLongEdge() {
        XCTAssertEqual(
            ImageResizePolicy.computeResizeDimensions(width: 1000, height: 500, maxLongEdge: 400),
            ImageResizeDimensions(width: 400, height: 200, resized: true)
        )
    }

    func testDegenerateDimensionsPassThrough() {
        let zero = ImageResizePolicy.computeResizeDimensions(width: 0, height: 100)
        XCTAssertEqual(zero, ImageResizeDimensions(width: 0, height: 100, resized: false))

        let negative = ImageResizePolicy.computeResizeDimensions(width: -1, height: 100)
        XCTAssertEqual(negative, ImageResizeDimensions(width: -1, height: 100, resized: false))

        let nan = ImageResizePolicy.computeResizeDimensions(width: .nan, height: 100)
        XCTAssertTrue(nan.width.isNaN)
        XCTAssertEqual(nan.height, 100)
        XCTAssertFalse(nan.resized)

        let infinity = ImageResizePolicy.computeResizeDimensions(width: .infinity, height: 100)
        XCTAssertEqual(infinity.width, .infinity)
        XCTAssertEqual(infinity.height, 100)
        XCTAssertFalse(infinity.resized)
    }

    func testInvalidMaximumLongEdgePassesThrough() {
        for maxLongEdge in [0.0, -1.0, .nan, .infinity] {
            let result = ImageResizePolicy.computeResizeDimensions(
                width: 4032, height: 3024, maxLongEdge: maxLongEdge)
            XCTAssertEqual(result.width, 4032)
            XCTAssertEqual(result.height, 3024)
            XCTAssertFalse(result.resized)
        }
    }

    func testResizeConstantsMirrorWebClient() {
        XCTAssertEqual(ImageResizePolicy.maxLongEdge, 1568)
        XCTAssertEqual(ImageResizePolicy.lossyQuality, 0.85)
    }

    func testWebResizableMimeTypesAreSelected() {
        XCTAssertTrue(ImageResizePolicy.isResizableImageMime("image/jpeg"))
        XCTAssertTrue(ImageResizePolicy.isResizableImageMime("image/png"))
        XCTAssertTrue(ImageResizePolicy.isResizableImageMime("image/webp"))
    }

    func testAnimatedGIFIsNotSelectedForResize() {
        XCTAssertFalse(ImageResizePolicy.isResizableImageMime("image/gif"))
        XCTAssertFalse(ImageResizePolicy.isResizableImageMime("image/heic"))
        XCTAssertFalse(ImageResizePolicy.isResizableImageMime("text/plain"))
    }
}
