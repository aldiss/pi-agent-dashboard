import XCTest
@testable import PiDashboardKit

final class DashboardNavigationPolicyTests: XCTestCase {
    func testRegularWidthUsesSplitView() {
        XCTAssertEqual(DashboardNavigationPolicy.layout(for: .regular), .splitView)
    }

    func testCompactWidthKeepsStackNavigation() {
        XCTAssertEqual(DashboardNavigationPolicy.layout(for: .compact), .stack)
    }

    func testUnspecifiedWidthKeepsStackNavigation() {
        XCTAssertEqual(DashboardNavigationPolicy.layout(for: nil), .stack)
    }

    func testResizingReevaluatesLayoutWithoutDeviceAssumptions() {
        let widths: [DashboardNavigationPolicy.Width?] = [.compact, .regular, .compact, nil, .regular]
        XCTAssertEqual(widths.map { DashboardNavigationPolicy.layout(for: $0) },
                       [.stack, .splitView, .stack, .stack, .splitView])
    }
}
