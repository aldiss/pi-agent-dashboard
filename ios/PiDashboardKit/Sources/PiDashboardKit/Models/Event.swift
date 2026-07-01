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

    private enum K: String, CodingKey { case eventType, timestamp, data }

    /// RESILIENT decode (Cluster 6): a partially-malformed event must DEGRADE, never
    /// throw — otherwise one bad field drops the whole frame (or the whole replay
    /// batch). Each field falls back independently: `eventType` → "unknown" (the
    /// reducer routes it to a raw row), `timestamp` → 0, `data` → [:] . So even a
    /// garbled event still renders *something*.
    public init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: K.self)
        self.eventType = (try? c?.decodeIfPresent(String.self, forKey: .eventType) ?? nil) ?? "unknown"
        self.timestamp = (try? c?.decodeIfPresent(Double.self, forKey: .timestamp) ?? nil) ?? 0
        self.data = (try? c?.decodeIfPresent([String: JSONValue].self, forKey: .data) ?? nil) ?? [:]
    }
}

/// A sequenced event as carried by the WS `event` / `event_replay` messages.
public struct SequencedEvent: Codable, Sendable, Equatable {
    public let seq: Int
    public let event: DashboardEvent

    public init(seq: Int, event: DashboardEvent) {
        self.seq = seq
        self.event = event
    }

    private enum K: String, CodingKey { case seq, event }

    /// RESILIENT decode (Cluster 6): a missing/garbled `seq` → 0 (rather than dropping
    /// the item from the replay batch); `event` degrades via its own resilient decode.
    public init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: K.self)
        self.seq = (try? c?.decodeIfPresent(Int.self, forKey: .seq) ?? nil) ?? 0
        self.event = (try? c?.decodeIfPresent(DashboardEvent.self, forKey: .event) ?? nil)
            ?? DashboardEvent(eventType: "unknown", timestamp: 0)
    }
}
