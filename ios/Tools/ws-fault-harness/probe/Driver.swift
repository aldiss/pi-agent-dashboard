import Foundation
import PiDashboardKit

// Drives the REAL shipped DashboardStore (symlinked, unmodified) through a
// server-initiated disconnect. Question: after it reconnects, does the open chat
// get re-subscribed? Ground truth is read from the SERVER's frame log, not from
// what the client believes it sent.

@MainActor
@main
struct RealStoreProbe {
    static func main() async {
        let url = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "http://127.0.0.1:8850"
        let budget = CommandLine.arguments.count > 2 ? Double(CommandLine.arguments[2])! : 40
        let openDelay = CommandLine.arguments.count > 3 ? Double(CommandLine.arguments[3])! : 2
        let start = Date()
        func el() -> String { String(format: "%.2f", Date().timeIntervalSince(start)) }

        let store = DashboardStore()
        store.serverURLString = url
        await store.connect()
        if openDelay > 0 { try? await Task.sleep(for: .seconds(openDelay)) }
        await store.openSession("sess-probe-1")
        print("[store \(el())s] opened chat; phase=\(store.phase)")

        // arg 4: seconds after which to simulate a foreground return (scenePhase .active
        // -> store.revalidate()), which is the path the operator hits every unlock.
        let revalidateAt = CommandLine.arguments.count > 4 ? Double(CommandLine.arguments[4])! : -1
        if revalidateAt > 0 {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(revalidateAt))
                print("[store \(el())s] simulating foreground return -> revalidate()")
                store.revalidate()
            }
        }
        var lastPhase = "\(store.phase)"
        let deadline = Date().addingTimeInterval(budget)
        while Date() < deadline {
            let p = "\(store.phase)"
            if p != lastPhase { print("[store \(el())s] phase -> \(p)"); lastPhase = p }
            try? await Task.sleep(for: .milliseconds(120))
        }
        print("[store \(el())s] final: phase=\(store.phase) sessions=\(store.sessions.count)")
        exit(0)
    }
}
