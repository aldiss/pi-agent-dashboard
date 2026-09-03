import XCTest
@testable import PiDashboardKit

final class PinDirectoryMessageTests: XCTestCase {

    private func encode(_ message: ClientMessage) throws -> [String: Any] {
        let data = try JSONEncoder().encode(message)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func pinnedPaths(from json: String) throws -> [String] {
        let message = try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
        guard case .pinnedDirsUpdated(let paths) = message else {
            XCTFail("expected pinned_dirs_updated")
            return []
        }
        return paths
    }

    func testPinDirectoryMessageShape() throws {
        let object = try encode(.pinDirectory(path: "/Users/op/proj"))
        XCTAssertEqual(object["type"] as? String, "pin_directory")
        XCTAssertEqual(object["path"] as? String, "/Users/op/proj")
        XCTAssertNil(object["sessionId"])
        XCTAssertEqual(object.keys.count, 2, "only type + path")
    }

    func testUnpinDirectoryMessageShape() throws {
        let object = try encode(.unpinDirectory(path: "/Users/op/proj"))
        XCTAssertEqual(object["type"] as? String, "unpin_directory")
        XCTAssertEqual(object["path"] as? String, "/Users/op/proj")
        XCTAssertNil(object["sessionId"])
        XCTAssertEqual(object.keys.count, 2, "only type + path")
    }

    func testReorderPinnedDirsSendsFullOrderedArray() throws {
        let paths = ["/b", "/a", "/c"]
        let object = try encode(.reorderPinnedDirs(paths: paths))
        XCTAssertEqual(object["type"] as? String, "reorder_pinned_dirs")
        XCTAssertEqual(object["paths"] as? [String], paths)
        XCTAssertEqual(object.keys.count, 2, "only type + paths")
    }

    func testPathIsSentVerbatimNotNormalized() throws {
        let path = "/Users/op/proj/"
        let object = try encode(.pinDirectory(path: path))
        XCTAssertEqual(object["path"] as? String, path)
    }

    func testReorderPayloadPreservesOrderAndCompleteness() throws {
        let all = ["/a", "/b", "/c", "/d"]
        let moved = ["/c", "/a", "/b", "/d"]
        let object = try encode(.reorderPinnedDirs(paths: moved))
        XCTAssertEqual(object["paths"] as? [String], moved, "exact order, no sorting")
        XCTAssertEqual((object["paths"] as? [String])?.count, all.count,
                       "every pinned dir is present — a partial list DELETES the omitted pins")
    }

    func testFailedPinRollsBackOptimisticState() throws {
        var state = PinnedDirectoriesState(paths: ["/existing"])
        XCTAssertTrue(state.beginPin(path: "/new/"))
        XCTAssertEqual(state.paths, ["/existing", "/new/"])

        state.finishSend(succeeded: false)

        XCTAssertEqual(state.paths, ["/existing"])
    }

    func testFailedUnpinRollsBackOptimisticState() throws {
        var state = PinnedDirectoriesState(paths: ["/a", "/remove/", "/b"])
        XCTAssertTrue(state.beginUnpin(path: "/remove"))
        XCTAssertEqual(state.paths, ["/a", "/b"])

        state.finishSend(succeeded: false)

        XCTAssertEqual(state.paths, ["/a", "/remove/", "/b"])
    }

    func testCanonicalMembershipPreventsDuplicateOptimisticPin() {
        var state = PinnedDirectoriesState(paths: ["/a"])
        XCTAssertFalse(state.beginPin(path: "/a/"))
    }

    func testAuthoritativeBroadcastWinsOverFailedOptimisticSend() throws {
        var state = PinnedDirectoriesState()
        XCTAssertTrue(state.beginPin(path: "/Users/op/proj/"))

        let broadcast = try pinnedPaths(
            from: #"{"type":"pinned_dirs_updated","paths":["/Users/op/proj"]}"#)
        state.reconcileAuthoritative(broadcast)
        state.finishSend(succeeded: false)

        XCTAssertEqual(state.paths, ["/Users/op/proj"],
                       "server broadcast replaces optimistic state and must not be rolled back")
    }

    func testAuthoritativeBroadcastEqualToOptimisticValueSurvivesFailedSend() throws {
        var state = PinnedDirectoriesState()
        XCTAssertTrue(state.beginPin(path: "/new"))
        XCTAssertEqual(state.paths, ["/new"])

        let broadcast = try pinnedPaths(
            from: #"{"type":"pinned_dirs_updated","paths":["/new"]}"#)
        state.reconcileAuthoritative(broadcast)
        state.finishSend(succeeded: false)

        XCTAssertEqual(state.paths, ["/new"],
                       "an equal-valued broadcast is still authoritative reconciliation")
    }

    func testOverlappingMutationsCannotLeaveStaleOptimisticState() throws {
        var state = PinnedDirectoriesState(paths: ["/existing"])
        XCTAssertTrue(state.beginPin(path: "/first"))

        XCTAssertFalse(state.beginPin(path: "/overlap"),
                       "only one unresolved optimistic mutation may own rollback state")
        state.finishSend(succeeded: false)

        XCTAssertEqual(state.paths, ["/existing"])
        XCTAssertTrue(state.beginPin(path: "/overlap"),
                      "a completed mutation must release the next operation")
    }

    func testDashboardStorePinnedBroadcastUsesReducerReconciliation() throws {
        var iosDirectory = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { iosDirectory.deleteLastPathComponent() }
        let sourceURL = iosDirectory
            .appendingPathComponent("PiDashboard/Sources/DashboardStore.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let caseStart = try XCTUnwrap(source.range(of: "case .pinnedDirsUpdated(let paths):"))
        let nextCase = try XCTUnwrap(
            source.range(of: "case ", range: caseStart.upperBound..<source.endIndex))
        let caseBody = source[caseStart.lowerBound..<nextCase.lowerBound]
        let helperStart = try XCTUnwrap(
            source.range(of: "private func reconcilePinnedDirectories(_ paths: [String]) {"))
        let helperEnd = try XCTUnwrap(
            source.range(of: "\n    }", range: helperStart.upperBound..<source.endIndex))
        let helperBody = source[helperStart.lowerBound..<helperEnd.upperBound]
        let caseCode = caseBody.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.split(separator: "//", maxSplits: 1,
                            omittingEmptySubsequences: false)[0] }.joined(separator: "\n")
        let helperCode = helperBody.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.split(separator: "//", maxSplits: 1,
                            omittingEmptySubsequences: false)[0] }.joined(separator: "\n")

        XCTAssertTrue(
            caseCode.contains("reconcilePinnedDirectories(paths)"),
            "the production pinned_dirs_updated transition must route through the reducer")
        XCTAssertTrue(
            helperCode.contains("pinnedDirectoriesState.reconcileAuthoritative(paths)"),
            "the store reconciliation helper must apply the Kit reducer")
        XCTAssertFalse(caseCode.contains("pinnedDirectories = paths"),
                       "the production transition must not bypass reducer reconciliation")
    }

    func testFlatBucketHasNoPinAction() throws {
        let groups = SessionGrouping.groupTierByFolder(
            [DashboardSession(id: "s", cwd: "/Users/op/proj")], folders: false)
        let flat = try XCTUnwrap(groups.first)
        XCTAssertEqual(flat.cwd, "")
        XCTAssertNil(DirectoryPinAction.resolve(cwd: flat.cwd, pinned: flat.pinned))
        XCTAssertEqual(DirectoryPinAction.resolve(cwd: "/Users/op/proj", pinned: false), .pin)
        XCTAssertEqual(DirectoryPinAction.resolve(cwd: "/Users/op/proj", pinned: true), .unpin)
    }
}
