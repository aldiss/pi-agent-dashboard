import Foundation

/// Which call path opened a socket. B10's central unresolved question is whether the
/// app supersedes its own connections, so the opener must be recorded at the moment
/// of opening — it cannot be reconstructed afterwards.
public enum ConnectOrigin: String, Sendable, Equatable {
    case initial
    case scheduledReconnect
    case foregroundRecovery
    case unknown
}

/// One recorded moment in a single socket's life.
public struct SocketTraceEvent: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        /// A caller asked for a socket. Carries WHICH caller.
        case connectRequested(origin: ConnectOrigin)
        /// The task exists. Carries the effective receive ceiling actually in force.
        case socketOpened(maxMessageBytes: Int)
        /// Extensions negotiated on the upgrade response — settles whether
        /// permessage-deflate was actually agreed on THIS device, rather than assumed.
        case upgradeNegotiated(extensions: String?)
        case received(bytes: Int, kind: String)
        /// A snapshot was applied. This is the event that resets reconnect backoff, so
        /// its presence explains a flat retry cadence and its absence disproves one.
        case snapshotApplied(bytes: Int)
        /// The app tore this socket down itself.
        case localDisconnect(caller: String)
        /// This loop lost the identity check: a newer socket replaced it. Recorded
        /// BEFORE the guard returns — the case the current instrumentation cannot see.
        case superseded(caller: String)
        /// First receive failure, with the real error rather than a localized string.
        /// `wasCurrent` distinguishes "the live socket died" from "an already-replaced
        /// socket finally noticed", which is the supersession fork.
        case receiveFailed(domain: String, code: Int, closeCode: Int,
                           closeReason: String?, wasCurrent: Bool)
        case streamFinished
    }

    /// Monotonic stamp taken at the CALL SITE. Cross-actor writes can arrive out of
    /// order, so ordering is restored at render time from this, never from arrival.
    public let at: Double
    /// Per-socket identity. Without it, concurrent sockets blur into one another and
    /// the trace cannot answer which connection did what.
    public let socketID: String
    public let kind: Kind

    public init(at: Double, socketID: String, kind: Kind) {
        self.at = at; self.socketID = socketID; self.kind = kind
    }
}

/// Bounded, ordered lifecycle trace for diagnosing B10.
///
/// WHY IT EXISTS. The socket is accepted, carries a snapshot, and dies within a few
/// hundred milliseconds, repeatedly. Every instrument tried so far has been consistent
/// with several causes at once — the server's close handler discards its code, the
/// client kept only a localized error string, and the close classifier reports an
/// injected 1012 as 1005. This records the specific facts whose combination separates
/// the remaining hypotheses in a single captured flap:
/// self-inflicted supersession, a receive-limit rejection, or an upstream transport
/// failure.
///
/// Pure and clock-injected so every branch is reachable from `swift test`.
public struct SocketTrace: Sendable {
    public let capacity: Int
    public private(set) var events: [SocketTraceEvent] = []

    public init(capacity: Int = 400) { self.capacity = max(1, capacity) }

    /// Append, dropping the OLDEST when full. The interesting moment is always the
    /// most recent flap, so newest must survive.
    public mutating func record(_ event: SocketTraceEvent) {
        events.append(event)
        if events.count > capacity { events.removeFirst(events.count - capacity) }
    }

    public func events(for socketID: String) -> [SocketTraceEvent] {
        events.filter { $0.socketID == socketID }
    }

    /// Operator-readable text. The trace is worthless if it cannot leave the device,
    /// so this is what a copy button emits.
    public func rendered() -> String {
        events.sorted { $0.at < $1.at }.map { e in
            "\(String(format: "%.3f", e.at))  \(e.socketID)  \(Self.describe(e.kind))"
        }.joined(separator: "\n")
    }

    private static func describe(_ k: SocketTraceEvent.Kind) -> String {
        switch k {
        case .connectRequested(let o):        return "connectRequested origin=\(o.rawValue)"
        case .socketOpened(let m):            return "socketOpened maxMessageBytes=\(m)"
        case .upgradeNegotiated(let e):       return "upgradeNegotiated extensions=\(e ?? "none")"
        case .received(let b, let t):         return "received bytes=\(b) kind=\(t)"
        case .snapshotApplied(let b):         return "snapshotApplied bytes=\(b)"
        case .localDisconnect(let c):         return "localDisconnect caller=\(c)"
        case .superseded(let c):              return "superseded caller=\(c)"
        case .receiveFailed(let d, let c, let cc, let r, let cur):
            return "receiveFailed domain=\(d) code=\(c) closeCode=\(cc) "
                 + "reason=\(r ?? "none") wasCurrent=\(cur)"
        case .streamFinished:                 return "streamFinished"
        }
    }
}

/// Process-wide collector. Both the networking actor and the main-actor store write
/// to it, so it is an actor; ordering is recovered from the call-site stamps.
public actor SocketTraceLog {
    public static let shared = SocketTraceLog()
    private var trace = SocketTrace()
    public init() {}
    public func record(_ event: SocketTraceEvent) { trace.record(event) }
    public func rendered() -> String { trace.rendered() }
    public func snapshot() -> [SocketTraceEvent] { trace.events }
    public func clear() { trace = SocketTrace() }

    /// Convenience for the main-actor store, which has no socket id in hand. The
    /// snapshot apply is correlated to its socket by TIME, which is sufficient because
    /// only one socket can be delivering at a given instant.
    public nonisolated static func recordSnapshotApplied(sessionCount: Int) {
        let at = Date().timeIntervalSince1970
        Task {
            await SocketTraceLog.shared.record(
                SocketTraceEvent(at: at, socketID: "store",
                                 kind: .snapshotApplied(bytes: sessionCount)))
        }
    }
}
