import Foundation

/// The six message-type categories the chat filter toggles — the taxonomy lifted
/// from the PWA (`message-filter-classifier.ts` / `message-filter-storage.ts`).
/// Each rendered chat row classifies into exactly one; the filter shows/hides by
/// category so the operator can dim tool spam + debug noise while keeping asks +
/// narrative.
public enum MessageCategory: String, Sendable, Equatable, CaseIterable {
    case tierA               // operator-direct asks (ask_user / confirm / select)
    case tierB               // narrative fallback (digest rows, unenumerated roles)
    case tierC               // ledger-only (rare in the dashboard)
    case meshChatter         // plain user / assistant chat
    case toolCalls           // tool results / bash output / command feedback
    case systemNotifications // thinking / turn separators / raw debug events
}

/// The 6-category on/off filter — native mirror of the PWA `MessageFilter`. `Codable`
/// so it persists to UserDefaults; `Equatable` for the default check + change diffing.
public struct MessageFilter: Codable, Sendable, Equatable {
    public var tierA: Bool
    public var tierB: Bool
    public var tierC: Bool
    public var meshChatter: Bool
    public var toolCalls: Bool
    public var systemNotifications: Bool

    public init(tierA: Bool, tierB: Bool, tierC: Bool,
                meshChatter: Bool, toolCalls: Bool, systemNotifications: Bool) {
        self.tierA = tierA; self.tierB = tierB; self.tierC = tierC
        self.meshChatter = meshChatter; self.toolCalls = toolCalls
        self.systemNotifications = systemNotifications
    }

    /// Canonical defaults (PWA `DEFAULT_MESSAGE_FILTER`, W3 Q2 recommended): Tier-A /
    /// Tier-B / mesh-chatter ON; Tier-C / tool-calls / system-notifications OFF. With
    /// these the chat shows asks + narrative + chat — tool spam + thinking + raw
    /// lifecycle rows (the operator's "empty tool calls") are hidden.
    public static let `default` = MessageFilter(
        tierA: true, tierB: true, tierC: false,
        meshChatter: true, toolCalls: false, systemNotifications: false)

    /// Whether `self` equals the canonical defaults (drives the header badge + the
    /// "Reset" affordance visibility).
    public var isDefault: Bool { self == MessageFilter.default }

    /// Whether every category is on (renderer can skip the filter pass entirely).
    public var isAllOn: Bool {
        tierA && tierB && tierC && meshChatter && toolCalls && systemNotifications
    }

    /// Read the on/off flag for a category (drives `filter(_:)` + the pill state).
    public func isOn(_ category: MessageCategory) -> Bool {
        switch category {
        case .tierA: return tierA
        case .tierB: return tierB
        case .tierC: return tierC
        case .meshChatter: return meshChatter
        case .toolCalls: return toolCalls
        case .systemNotifications: return systemNotifications
        }
    }

    /// Return a copy with `category` set to `on` (pill toggle).
    public func setting(_ category: MessageCategory, _ on: Bool) -> MessageFilter {
        var f = self
        switch category {
        case .tierA: f.tierA = on
        case .tierB: f.tierB = on
        case .tierC: f.tierC = on
        case .meshChatter: f.meshChatter = on
        case .toolCalls: f.toolCalls = on
        case .systemNotifications: f.systemNotifications = on
        }
        return f
    }
}

/// Pure classifier + filter pass — native adaptation of the PWA
/// `message-filter-classifier.ts`. The native `ChatRole` model has NO `interactiveUi`
/// role and NO `skill` envelope (unlike the PWA `ChatMessage`), so:
///   - an `ask_user` surfaces as a `.toolResult` whose `toolName == "ask_user"` →
///     that's the operator-direct ask → `tierA` (the rest of `.toolResult` → toolCalls);
///   - `.bashOutput` / `.commandFeedback` → `toolCalls`;
///   - `.thinking` / `.turnSeparator` / `.rawEvent` → `systemNotifications`;
///   - `.user` / `.assistant` → `meshChatter`.
///
/// NOTE (thinking): the OPERATOR BRIEF lists `thinking → systemNotifications` (hidden
/// by default — the operator's clutter complaint). The current PWA source instead
/// reclassifies `thinking → tierB` (visible). This implements the BRIEF. To match the
/// PWA exactly, move `.thinking` out of `systemRoles` into the `tierB` return. It is
/// a one-line flip.
public enum MessageClassifier {

    /// Classify one rendered chat row into its category.
    public static func classify(_ message: ChatMessage) -> MessageCategory {
        switch message.role {
        case .toolResult:
            // ask_user is the operator-direct interactive card in the native model.
            return message.toolName == "ask_user" ? .tierA : .toolCalls
        case .bashOutput, .commandFeedback:
            return .toolCalls
        case .thinking, .turnSeparator, .rawEvent:
            return .systemNotifications
        case .user, .assistant:
            return .meshChatter
        }
    }

    /// Filter a message list to the rows whose category is ON. Pure — never mutates.
    /// The common all-on case short-circuits (returns the input unchanged).
    public static func filter(_ messages: [ChatMessage], _ filter: MessageFilter) -> [ChatMessage] {
        if filter.isAllOn { return messages }
        return messages.filter { filter.isOn(classify($0)) }
    }

    /// Per-category counts over a message list (drives the pill count suffixes).
    public static func counts(_ messages: [ChatMessage]) -> [MessageCategory: Int] {
        var counts: [MessageCategory: Int] = [:]
        for m in messages { counts[classify(m), default: 0] += 1 }
        return counts
    }
}
