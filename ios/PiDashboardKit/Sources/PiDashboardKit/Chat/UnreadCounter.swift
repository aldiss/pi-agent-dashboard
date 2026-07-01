import Foundation

/// Engagement-weighted unread computation (DF#3). The operator's complaint: an agent
/// produces hundreds of tool-calls, so a RAW unread count is noise. What matters is
/// how many messages that NEED the operator — Tier-A asks (`ask_user`/confirm/select)
/// — arrived since they last read. This pure helper computes that off the message
/// list + the persisted last-read id, reusing the existing `MessageClassifier` so the
/// "ask" definition stays single-sourced. Pure → fully `swift test`-able.
public enum UnreadCounter {
    /// The unread summary for one session, relative to `lastReadId`.
    public struct Summary: Sendable, Equatable {
        /// Count of Tier-A asks AFTER the read position (the weighted badge number).
        public let tierAUnread: Int
        /// First message id after the read position (drives the "X unread" divider).
        public let firstUnreadId: String?
        /// First Tier-A ask after the read position (drives "Jump to unread ask").
        public let firstUnreadTierAId: String?
        public init(tierAUnread: Int, firstUnreadId: String?, firstUnreadTierAId: String?) {
            self.tierAUnread = tierAUnread
            self.firstUnreadId = firstUnreadId
            self.firstUnreadTierAId = firstUnreadTierAId
        }
        public static let none = Summary(tierAUnread: 0, firstUnreadId: nil, firstUnreadTierAId: nil)
    }

    /// Compute the unread summary. Messages strictly AFTER `lastReadId` (by position
    /// in the list) are "unread". `lastReadId == nil` OR an id not present (stale)
    /// → the WHOLE list is unread (nothing confirmed read). `lastReadId` == the last
    /// message → zero unread. The Tier-A count reuses `MessageClassifier.classify`.
    public static func summarize(_ messages: [ChatMessage], lastReadId: String?) -> Summary {
        guard !messages.isEmpty else { return .none }
        // Start index of the unread slice: one past the last-read message, else 0.
        let start: Int
        if let lastReadId, let idx = messages.firstIndex(where: { $0.id == lastReadId }) {
            start = idx + 1
        } else {
            start = 0  // never read / stale id → all unread
        }
        guard start < messages.count else { return .none }
        let unread = messages[start...]
        let firstUnreadId = unread.first?.id
        var tierACount = 0
        var firstTierA: String?
        for m in unread where MessageClassifier.classify(m) == .tierA {
            tierACount += 1
            if firstTierA == nil { firstTierA = m.id }
        }
        return Summary(tierAUnread: tierACount, firstUnreadId: firstUnreadId,
                       firstUnreadTierAId: firstTierA)
    }

    /// Convenience: just the Tier-A unread count (the card badge number).
    public static func tierAUnreadCount(_ messages: [ChatMessage], lastReadId: String?) -> Int {
        summarize(messages, lastReadId: lastReadId).tierAUnread
    }
}
