import Foundation

/// Where the chat should be anchored when a session is opened.
public enum ChatOpenAnchor: Sendable, Equatable {
    /// The newest message. Used when there is no place to return to.
    case bottom
    /// Resume at a specific message the operator had already read up to.
    case message(id: String)
}

/// Decides where opening a chat lands.
///
/// WHY THIS EXISTS. `restoreOnOpen` resolved its anchor as
/// `lastReadId ?? firstUnreadId`. That reads as "resume, else go to the first thing
/// you haven't seen", which sounds right and is wrong at the boundary:
/// `UnreadCounter` treats a session with NO read position as *entirely* unread, so
/// `firstUnreadId` is the OLDEST message in the list. Opening a session for the first
/// time therefore anchored to the very beginning of its history, and the operator had
/// to scroll all the way down to reach current activity — reported 2026-09-05.
///
/// The rule is now explicit rather than emergent: a session opened BEFORE returns to
/// where the operator was; a session opened for the FIRST time goes to the end.
/// `firstUnreadId` still drives the "N unread" divider, which is what it is actually
/// good for — it just no longer decides the scroll position.
public enum ChatOpenPolicy {

    /// - Parameters:
    ///   - lastReadId: the operator's confirmed read position in THIS session, or nil
    ///     if this device has never opened it.
    ///   - firstUnreadId: first message after the read position. Deliberately unused
    ///     for anchoring — see above. Kept in the signature so the call site cannot
    ///     silently reintroduce it without touching this contract and its tests.
    public static func anchor(lastReadId: String?, firstUnreadId: String?) -> ChatOpenAnchor {
        guard let lastReadId, !lastReadId.isEmpty else { return .bottom }
        return .message(id: lastReadId)
    }
}
