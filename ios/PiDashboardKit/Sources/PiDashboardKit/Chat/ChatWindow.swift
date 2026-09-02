import Foundation

/// Pure history-windowing for the chat view (DF#5 perf). A large session (SwiftPilot's
/// all-day transcript — hundreds/thousands of rows) must NOT render every row: the
/// view renders only the most-recent `limit` and pages older ones in on demand. This
/// is the single biggest render lever — a 1000-row session shows ~175 rows, not 1000.
///
/// Pure + `Sendable` so the windowing is `swift test`-able with no SwiftUI; the view
/// owns only the `showAll` toggle + the "Load earlier" button.
public enum ChatWindow {
    /// Default render window — most-recent N rows. ~175 keeps a deep scrollback while
    /// bounding the realized LazyVStack rows on open.
    public static let defaultLimit = 175

    /// The windowed slice the view renders.
    public struct Windowed: Sendable, Equatable {
        /// The rows to render (tail of `messages`, in original order).
        public let rows: [ChatMessage]
        /// How many older rows were clipped from the head (drives "Load earlier +N").
        public let hiddenCount: Int
        public init(rows: [ChatMessage], hiddenCount: Int) {
            self.rows = rows; self.hiddenCount = hiddenCount
        }
    }

    /// Return the most-recent `limit` rows (order preserved) plus the count clipped
    /// from the head. `showAll == true` (operator tapped "Load earlier") → every row,
    /// hiddenCount 0. `limit <= 0` or `messages.count <= limit` → all rows. Pure.
    public static func window(_ messages: [ChatMessage], limit: Int = defaultLimit,
                              showAll: Bool = false) -> Windowed {
        if showAll || limit <= 0 || messages.count <= limit {
            return Windowed(rows: messages, hiddenCount: 0)
        }
        let hidden = messages.count - limit
        return Windowed(rows: Array(messages.suffix(limit)), hiddenCount: hidden)
    }
}

/// Pure viewport decision shared by chat auto-follow and live read marking.
/// A missing bottom-sentinel measurement means the lazy sentinel is not realized,
/// which must behave as far from the bottom rather than as distance zero.
public enum ChatViewportPolicy {
    public static let nearBottomThreshold = 160.0

    public struct Decision: Sendable, Equatable {
        public let shouldAutoFollow: Bool
        public let shouldMarkRead: Bool

        public init(shouldAutoFollow: Bool, shouldMarkRead: Bool) {
            self.shouldAutoFollow = shouldAutoFollow
            self.shouldMarkRead = shouldMarkRead
        }
    }

    public static func decide(bottomDistance: Double?) -> Decision {
        guard let bottomDistance else {
            return Decision(shouldAutoFollow: false, shouldMarkRead: false)
        }
        let isNearBottom = bottomDistance <= nearBottomThreshold
        return Decision(shouldAutoFollow: isNearBottom, shouldMarkRead: isNearBottom)
    }
}
