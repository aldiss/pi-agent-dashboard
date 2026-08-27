import Foundation
import PiDashboardKit

// Drives the REAL shipped DashboardStore (symlinked, unmodified) through a
// server-initiated disconnect. Question: after it reconnects, does the open chat
// get re-subscribed? Ground truth is read from the SERVER's frame log, not from
// what the client believes it sent.

@MainActor
@main
struct RealStoreProbe {
    private struct ProbeStats: Decodable {
        let rejectedUpgradeCount: Int
    }

    private static func rejectedUpgradeCount(at baseURL: String) async -> Int? {
        guard var components = URLComponents(string: baseURL) else { return nil }
        components.path = "/__probe/stats"
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { return nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        guard let (data, _) = try? await session.data(from: url) else { return nil }
        return try? JSONDecoder().decode(ProbeStats.self, from: data).rejectedUpgradeCount
    }

    private static func driveOrigin(_ url: String, label: String, start: Date) async {
        func el() -> String { String(format: "%.2f", Date().timeIntervalSince(start)) }
        let store = DashboardStore(
            idleAckDeadline: .seconds(5), queueAckDeadline: .seconds(8))
        store.serverURLString = url
        await store.connect()
        for _ in 0..<40 {
            if "\(store.phase)" == "connected" { break }
            try? await Task.sleep(for: .milliseconds(50))
        }
        await store.openSession("sess-probe-1")
        try? await Task.sleep(for: .milliseconds(300))
        print("[store \(el())s] cross-origin \(label): phase=\(store.phase)")
        store.disconnect()
        try? await Task.sleep(for: .milliseconds(300))
    }

    private static func runCrossOrigin(
        originAURL: String, originBURL: String, start: Date
    ) async {
        guard let aURL = URL(string: originAURL), let originA = CredentialOrigin(url: aURL),
              let bURL = URL(string: originBURL), let originB = CredentialOrigin(url: bURL)
        else {
            print("[store] invalid cross-origin probe URLs")
            exit(2)
        }

        AuthCookieStore.prepareLegacyProbe()
        AuthCookieStore.migrateLegacyIfNeeded(into: originA)
        print("[store] migration attributed: legacy=\(AuthCookieStore.probeHasLegacy) origin=\(AuthCookieStore.probeContains(originKey: originA.storageKey))")
        AuthCookieStore.prepareLegacyProbe()
        AuthCookieStore.migrateLegacyIfNeeded(into: nil)
        print("[store] migration unattributed: legacy=\(AuthCookieStore.probeHasLegacy) deleted=\(!AuthCookieStore.probeContains(originKey: originA.storageKey))")

        AuthCookieStore.prepareProbe(originKeys: [originA.storageKey])
        await driveOrigin(originAURL, label: "A", start: start)
        await driveOrigin(originBURL, label: "B", start: start)
        print("[store] cross-origin final: A=\(AuthCookieStore.probeContains(originKey: originA.storageKey)) B=\(AuthCookieStore.probeContains(originKey: originB.storageKey))")
    }

    static func main() async {
        let url = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "http://127.0.0.1:8850"
        let budget = CommandLine.arguments.count > 2 ? Double(CommandLine.arguments[2])! : 40
        let openDelay = CommandLine.arguments.count > 3 ? Double(CommandLine.arguments[3])! : 2
        let start = Date()
        func el() -> String { String(format: "%.2f", Date().timeIntervalSince(start)) }
        let scenario = CommandLine.arguments.count > 10 ? CommandLine.arguments[10] : "default"
        let originAURL = CommandLine.arguments.count > 11 ? CommandLine.arguments[11] : url
        let originBURL = CommandLine.arguments.count > 12 ? CommandLine.arguments[12] : "http://localhost:8850"

        if scenario == "cross-origin" {
            await runCrossOrigin(originAURL: originAURL, originBURL: originBURL, start: start)
            return
        }

        if scenario == "auth-reject",
           let aURL = URL(string: originAURL), let originA = CredentialOrigin(url: aURL),
           let bURL = URL(string: originBURL), let originB = CredentialOrigin(url: bURL) {
            AuthCookieStore.prepareProbe(originKeys: [originA.storageKey, originB.storageKey])
        }

        // Production defaults are 30s idle / 90s queued. Short probe deadlines
        // exercise the same store branches without making each harness mode minutes long.
        let store = DashboardStore(
            idleAckDeadline: .seconds(5), queueAckDeadline: .seconds(8))
        store.serverURLString = url
        var lastPhase = "\(store.phase)"
        await store.connect()
        if scenario != "auth-reject" {
            if openDelay > 0 { try? await Task.sleep(for: .seconds(openDelay)) }
            await store.openSession("sess-probe-1")
            print("[store \(el())s] opened chat; phase=\(store.phase)")
        }

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
        let competingMode = CommandLine.arguments.count > 6 ? CommandLine.arguments[6] : "single"
        let competingSend = competingMode == "competing" || competingMode == "same"
        if sendAt > 0 {
            Task { @MainActor in
                let remaining = max(0, sendAt - Date().timeIntervalSince(start))
                try? await Task.sleep(for: .seconds(remaining))
                print("[store \(el())s] sending into fault window")
                store.setDraftText("loss probe", for: "sess-probe-1")
                if await store.sendPrompt("sess-probe-1", text: "loss probe", images: nil) {
                    // Exactly what AdaptiveComposer does after local acceptance.
                    store.setDraftText("", for: "sess-probe-1")
                }
                if competingSend {
                    try? await Task.sleep(for: .seconds(1))
                    print("[store \(el())s] sending competing failure")
                    let secondText = competingMode == "same" ? "loss probe" : "other loss"
                    store.setDraftText(secondText, for: "sess-probe-1")
                    if await store.sendPrompt("sess-probe-1", text: secondText, images: nil) {
                        store.setDraftText("", for: "sess-probe-1")
                    }
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

        // arg 8: request the model catalogue twice. The second call must use cache
        // and emit no second request_models frame.
        let modelProbe = CommandLine.arguments.count > 8 ? CommandLine.arguments[8] : "off"
        if modelProbe != "off" {
            Task { @MainActor in
                await store.requestModels("sess-probe-1")
                try? await Task.sleep(for: .milliseconds(300))
                await store.requestModels("sess-probe-1")
            }
        }

        // arg 9: simulate an operator edit after automatic draft restoration.
        let editAt = CommandLine.arguments.count > 9 ? Double(CommandLine.arguments[9])! : -1
        if editAt > 0 {
            Task { @MainActor in
                let remaining = max(0, editAt - Date().timeIntervalSince(start))
                try? await Task.sleep(for: .seconds(remaining))
                store.setDraftText("loss probe ", for: "sess-probe-1")
                print("[store \(el())s] operator added trailing space to restored draft")
            }
        }
        var rejectionCounts: (atAuth: Int, afterSoak: Int)?
        let deadline = Date().addingTimeInterval(budget)
        while Date() < deadline {
            let p = "\(store.phase)"
            if p != lastPhase { print("[store \(el())s] phase -> \(p)"); lastPhase = p }
            if scenario == "auth-reject", p.contains("authRequired"), rejectionCounts == nil,
               let atAuth = await rejectedUpgradeCount(at: url) {
                try? await Task.sleep(for: .seconds(31))
                if let afterSoak = await rejectedUpgradeCount(at: url) {
                    rejectionCounts = (atAuth, afterSoak)
                    print("[store \(el())s] auth attempts: \(atAuth)->\(afterSoak)")
                }
            }
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
        let confirmedCount = finalState.messages.filter { $0.delivery == .confirmed }.count
        let failedCount = finalState.messages.filter { $0.delivery == .failed }.count
        let modelCount = store.availableModels["sess-probe-1"]?.count ?? -1
        let modelPhase = String(describing: store.modelListPhases["sess-probe-1"] ?? .idle)
        let queuedDelivery = finalState.queued.first { $0.text == "loss probe" }
            .map { String(describing: $0.status) } ?? "absent"
        let draft = store.draftText("sess-probe-1")
        print("[store \(el())s] final: phase=\(store.phase) sessions=\(store.sessions.count) delivery=\(delivery) other=\(otherDelivery) confirmed=\(confirmedCount) failed=\(failedCount) queue=\(queuedDelivery) failure=\(failure) prompts=\(promptCount) models=\(modelCount) modelPhase=\(modelPhase) draft=[\(draft)] contents=\(contents)")
        if scenario == "auth-reject",
           let aURL = URL(string: originAURL), let originA = CredentialOrigin(url: aURL),
           let bURL = URL(string: originBURL), let originB = CredentialOrigin(url: bURL) {
            let attempts = rejectionCounts.map { "\($0.atAuth)->\($0.afterSoak)" } ?? "unobserved"
            print("[store \(el())s] auth credentials: A=\(AuthCookieStore.probeContains(originKey: originA.storageKey) ? "present" : "absent") B=\(AuthCookieStore.probeContains(originKey: originB.storageKey) ? "present" : "absent") attempts=\(attempts)")
        }
        exit(0)
    }
}
