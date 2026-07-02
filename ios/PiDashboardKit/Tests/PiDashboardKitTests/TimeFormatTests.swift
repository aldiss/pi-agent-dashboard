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

    // MARK: elapsedClock (working-state timer "M:SS")

    func testElapsedClockFormatsMinutesAndSeconds() {
        let start = 1_000_000.0
        XCTAssertEqual(TimeFormat.elapsedClock(fromEpochMs: start, now: start + 45_000), "0:45")
        XCTAssertEqual(TimeFormat.elapsedClock(fromEpochMs: start, now: start + 12_000), "0:12")
        XCTAssertEqual(TimeFormat.elapsedClock(fromEpochMs: start, now: start + 65_000), "1:05")
        XCTAssertEqual(TimeFormat.elapsedClock(fromEpochMs: start, now: start + 5_000), "0:05") // zero-pad seconds
    }

    func testElapsedClockSubSecondIsZero() {
        let start = 1_000_000.0
        XCTAssertEqual(TimeFormat.elapsedClock(fromEpochMs: start, now: start + 900), "0:00") // <1s floors
    }

    func testElapsedClockMinutesRollPastSixty() {
        let start = 1_000_000.0
        XCTAssertEqual(TimeFormat.elapsedClock(fromEpochMs: start, now: start + 61 * 60_000 + 1_000), "61:01")
    }

    func testElapsedClockGuardsNonpositiveAndSkew() {
        XCTAssertEqual(TimeFormat.elapsedClock(fromEpochMs: 0, now: 5_000), "0:00")       // no start
        XCTAssertEqual(TimeFormat.elapsedClock(fromEpochMs: 5_000, now: 4_000), "0:00")   // now < start (skew)
        XCTAssertEqual(TimeFormat.elapsedClock(fromEpochMs: 5_000, now: 5_000), "0:00")   // equal
    }

    // MARK: elapsedClockOrNil (guarded working-state timer — suppresses garbage)

    /// The `45637:13` repro: a start ~31.7 days before `now`. The raw `elapsedClock`
    /// still formats the garbage H:MM (documenting the bug); the guard suppresses it.
    func testElapsedClockOrNilSuppressesAbsurdlyOldStart() {
        let start = 1_000_000.0
        let now = start + 2_738_233_000.0 // 45637 min 13 s ≈ 31.7 days
        XCTAssertEqual(TimeFormat.elapsedClock(fromEpochMs: start, now: now), "45637:13") // raw = garbage
        XCTAssertNil(TimeFormat.elapsedClockOrNil(fromEpochMs: start, now: now))          // guarded = suppressed
    }

    func testElapsedClockOrNilSuppressesMissingStart() {
        XCTAssertNil(TimeFormat.elapsedClockOrNil(fromEpochMs: 0, now: 5_000))    // start == 0
        XCTAssertNil(TimeFormat.elapsedClockOrNil(fromEpochMs: -5_000, now: 5_000)) // negative start
    }

    func testElapsedClockOrNilSuppressesNilStart() {
        let none: Double? = nil
        XCTAssertNil(TimeFormat.elapsedClockOrNil(fromEpochMs: none, now: 5_000)) // Double? overload
    }

    func testElapsedClockOrNilSuppressesSkew() {
        XCTAssertNil(TimeFormat.elapsedClockOrNil(fromEpochMs: 5_000, now: 4_000)) // now < start
        XCTAssertNil(TimeFormat.elapsedClockOrNil(fromEpochMs: 5_000, now: 5_000)) // equal (not-yet-started)
    }

    func testElapsedClockOrNilAllowsRealRecentStart() {
        let start = 1_000_000.0
        XCTAssertEqual(TimeFormat.elapsedClockOrNil(fromEpochMs: start, now: start + 45_000), "0:45")
        XCTAssertEqual(TimeFormat.elapsedClockOrNil(fromEpochMs: start, now: start + 12_000), "0:12")
        XCTAssertEqual(TimeFormat.elapsedClockOrNil(fromEpochMs: start, now: start + 65_000), "1:05")
    }

    func testElapsedClockOrNilOptionalOverloadAllowsRealStart() {
        let start: Double? = 1_000_000.0
        XCTAssertEqual(TimeFormat.elapsedClockOrNil(fromEpochMs: start, now: 1_045_000), "0:45")
    }

    /// Boundary: exactly at the plausible window is still shown; one ms past it is suppressed.
    func testElapsedClockOrNilWindowBoundary() {
        let start = 1_000_000.0
        let atEdge = start + TimeFormat.maxPlausibleElapsedMs        // exactly 6 h → allowed
        XCTAssertEqual(TimeFormat.elapsedClockOrNil(fromEpochMs: start, now: atEdge), "360:00")
        let pastEdge = start + TimeFormat.maxPlausibleElapsedMs + 1  // 6 h + 1 ms → suppressed
        XCTAssertNil(TimeFormat.elapsedClockOrNil(fromEpochMs: start, now: pastEdge))
    }
}
