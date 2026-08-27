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

        // arg 5: send an idle prompt at this elapsed second. Used by `send-loss`
        // mode after the server has black-holed the socket: URLSession accepts the
        // bytes locally, but no application-level acknowledgement can arrive.
        let sendAt = CommandLine.arguments.count > 5 ? Double(CommandLine.arguments[5])! : -1
        let competingSend = CommandLine.arguments.count > 6 && CommandLine.arguments[6] == "competing"
        if sendAt > 0 {
            Task { @MainActor in
                let remaining = max(0, sendAt - Date().timeIntervalSince(start))
                try? await Task.sleep(for: .seconds(remaining))
                print("[store \(el())s] sending into fault window")
                await store.sendPrompt("sess-probe-1", text: "loss probe", images: nil)
                if competingSend {
                    try? await Task.sleep(for: .seconds(1))
                    print("[store \(el())s] sending competing failure")
                    await store.sendPrompt("sess-probe-1", text: "other loss", images: nil)
                }
            }
        }

        // arg 7: answer the first PromptBus request once it arrives.
        let promptAnswer = CommandLine.arguments.count > 7 ? CommandLine.arguments[7] : "none"
        if promptAnswer != "none" {
            Task { @MainActor in
                for _ in 0..<50 {
                    if let prompt = store.prompts("sess-probe-1").first {
                        print("[store \(el())s] responding to prompt \(prompt.promptId)")
                        await store.respondToPrompt(
                            "sess-probe-1", promptId: prompt.promptId,
                            answer: promptAnswer, cancelled: false)
                        return
                    }
                    try? await Task.sleep(for: .milliseconds(100))
                }
            }
        }
        var lastPhase = "\(store.phase)"
        let deadline = Date().addingTimeInterval(budget)
        while Date() < deadline {
            let p = "\(store.phase)"
            if p != lastPhase { print("[store \(el())s] phase -> \(p)"); lastPhase = p }
            try? await Task.sleep(for: .milliseconds(120))
        }
        let finalState = store.chatState("sess-probe-1")
        let probe = finalState.messages.first { $0.content == "loss probe" }
        let other = finalState.messages.first { $0.content == "other loss" }
        let delivery = probe?.delivery.map { String(describing: $0) } ?? "absent"
        let otherDelivery = other?.delivery.map { String(describing: $0) } ?? "absent"
        let failure = store.sendFailures["sess-probe-1"] ?? "none"
        let contents = finalState.messages.map(\.content).joined(separator: "|")
        let promptCount = store.prompts("sess-probe-1").count
        print("[store \(el())s] final: phase=\(store.phase) sessions=\(store.sessions.count) delivery=\(delivery) other=\(otherDelivery) failure=\(failure) prompts=\(promptCount) contents=\(contents)")
        exit(0)
    }
}
