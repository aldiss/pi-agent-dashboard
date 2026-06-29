// swift-tools-version: 6.0
import PackageDescription

// PiDashboardKit — the UI-free core of the native pi-dashboard iPhone app.
// Holds Codable mirrors of the dashboard browser-protocol, the WS/REST clients,
// and the pure session grouping/filter + composer-layout logic. Builds and tests
// via `swift test` on the command line with ZERO simulator dependency, so the
// entire contract + logic layer is verifiable independently of the SwiftUI shell.
let package = Package(
    name: "PiDashboardKit",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [
        .library(name: "PiDashboardKit", targets: ["PiDashboardKit"]),
    ],
    targets: [
        .target(name: "PiDashboardKit"),
        .testTarget(
            name: "PiDashboardKitTests",
            dependencies: ["PiDashboardKit"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
