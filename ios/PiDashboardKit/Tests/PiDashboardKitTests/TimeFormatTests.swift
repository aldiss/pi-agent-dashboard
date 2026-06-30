import XCTest
@testable import PiDashboardKit

/// Tests for the pure chat time formatting. Timezone is injected so the wall-clock
/// assertions are deterministic regardless of the CI machine's zone.
final class TimeFormatTests: XCTestCase {

    private let utc = TimeZone(identifier: "UTC")!

    func testClockTime24Hour() {
        // 2026-06-30 13:05:00 UTC = 1782824700000 ms.
        let ms = 1_782_824_700_000.0
        XCTAssertEqual(TimeFormat.clockTime(fromEpochMs: ms, timeZone: utc), "13:05")
    }

    func testClockTimeIsZeroPadded() {
        // 2026-06-30 09:07:00 UTC = 1782810420000 ms.
        let ms = 1_782_810_420_000.0
        XCTAssertEqual(TimeFormat.clockTime(fromEpochMs: ms, timeZone: utc), "09:07")
    }

    func testClockTimeAfternoonStays24h() {
        // 2026-06-30 23:59:00 UTC = 1782863940000 ms (would be 11:59 PM in 12h).
        let ms = 1_782_863_940_000.0
        XCTAssertEqual(TimeFormat.clockTime(fromEpochMs: ms, timeZone: utc), "23:59")
    }

    func testClockTimeRespectsTimezone() {
        let ms = 1_782_824_700_000.0 // 13:05 UTC
        let plus2 = TimeZone(secondsFromGMT: 2 * 3600)!
        XCTAssertEqual(TimeFormat.clockTime(fromEpochMs: ms, timeZone: plus2), "15:05")
    }

    func testClockTimeEmptyForNonpositive() {
        XCTAssertEqual(TimeFormat.clockTime(fromEpochMs: 0, timeZone: utc), "")
        XCTAssertEqual(TimeFormat.clockTime(fromEpochMs: -5, timeZone: utc), "")
    }

    func testIsNewDayAcrossCalendarBoundary() {
        let day1 = 1_782_824_700_000.0 // 2026-06-30 13:05 UTC
        let day2 = day1 + 24 * 3600 * 1000 // 2026-07-01 13:05 UTC
        XCTAssertTrue(TimeFormat.isNewDay(day2, since: day1, timeZone: utc))
        XCTAssertFalse(TimeFormat.isNewDay(day1 + 3600 * 1000, since: day1, timeZone: utc)) // +1h same day
    }

    func testIsNewDayFalseForMissingPrior() {
        XCTAssertFalse(TimeFormat.isNewDay(1_782_824_700_000.0, since: 0, timeZone: utc))
    }
}
