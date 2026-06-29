import Foundation

/// An event forwarded from a pi session. Mirrors `DashboardEvent` in
/// `packages/shared/src/types.ts`. `eventType` discriminates; `data` is an
/// open-vocabulary payload the chat reducer interprets per type
/// (message stream, tool_execution_*, thinking, turn_end, subagent_*, …).
public struct DashboardEvent: Codable, Sendable, Equatable {
    public let eventType: String
    public let timestamp: Double
    public let data: [String: JSONValue]

    public init(eventType: String, timestamp: Double, data: [String: JSONValue] = [:]) {
        self.eventType = eventType
        self.timestamp = timestamp
        self.data = data
    }
}

/// A sequenced event as carried by the WS `event` / `event_replay` messages.
public struct SequencedEvent: Codable, Sendable, Equatable {
    public let seq: Int
    public let event: DashboardEvent
}
