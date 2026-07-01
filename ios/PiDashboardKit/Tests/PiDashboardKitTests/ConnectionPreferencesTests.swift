import XCTest
@testable import PiDashboardKit

/// Persistence round-trip for the launch-connection prefs (server URL + token).
/// Each test uses an ephemeral `UserDefaults` suite so it runs hermetically under
/// `swift test` with no simulator and no shared-state bleed.
final class ConnectionPreferencesTests: XCTestCase {
    private func makeEphemeralDefaults() -> (defaults: UserDefaults, suite: String) {
        let suite = "pi.dashboard.tests.\(UUID().uuidString)"
        return (UserDefaults(suiteName: suite)!, suite)
    }

    func testFreshInstallReturnsBakedInDefault() {
        let (d, suite) = makeEphemeralDefaults()
        defer { d.removePersistentDomain(forName: suite) }

        XCTAssertFalse(ConnectionPreferences.hasStoredServer(in: d),
                       "fresh install has no stored server")
        let prefs = ConnectionPreferences.load(from: d)
        XCTAssertEqual(prefs.serverURL, ConnectionPreferences.defaultServerURL,
                       "fresh install prefills the baked-in default")
        XCTAssertNil(prefs.token, "fresh install has no token")
    }

    func testSaveThenLoadRoundTrips() {
        let (d, suite) = makeEphemeralDefaults()
        defer { d.removePersistentDomain(forName: suite) }

        ConnectionPreferences.save(serverURL: "https://box.example:8443", token: "secret", to: d)

        XCTAssertTrue(ConnectionPreferences.hasStoredServer(in: d))
        let prefs = ConnectionPreferences.load(from: d)
        XCTAssertEqual(prefs.serverURL, "https://box.example:8443")
        XCTAssertEqual(prefs.token, "secret")
    }

    func testSaveTrimsURLAndNilTokenClears() {
        let (d, suite) = makeEphemeralDefaults()
        defer { d.removePersistentDomain(forName: suite) }

        ConnectionPreferences.save(serverURL: "  https://trim.me  ", token: "t", to: d)
        XCTAssertEqual(ConnectionPreferences.load(from: d).token, "t")

        // Re-save with a nil token → the stored token is cleared, URL kept (trimmed).
        ConnectionPreferences.save(serverURL: "https://trim.me", token: nil, to: d)
        let prefs = ConnectionPreferences.load(from: d)
        XCTAssertEqual(prefs.serverURL, "https://trim.me", "URL is trimmed on save")
        XCTAssertNil(prefs.token, "nil token clears the stored token")
    }

    func testClearRevertsToDefault() {
        let (d, suite) = makeEphemeralDefaults()
        defer { d.removePersistentDomain(forName: suite) }

        ConnectionPreferences.save(serverURL: "https://box.example", token: "x", to: d)
        ConnectionPreferences.clear(from: d)

        XCTAssertFalse(ConnectionPreferences.hasStoredServer(in: d))
        let prefs = ConnectionPreferences.load(from: d)
        XCTAssertEqual(prefs.serverURL, ConnectionPreferences.defaultServerURL)
        XCTAssertNil(prefs.token)
    }
}
