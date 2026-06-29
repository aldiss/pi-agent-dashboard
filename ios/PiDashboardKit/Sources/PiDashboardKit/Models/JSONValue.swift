import Foundation

/// A type-erased JSON value, used for the freeform `data: Record<string, unknown>`
/// payload on `DashboardEvent` and other open-vocabulary protocol fields.
/// Mirrors arbitrary JSON faithfully so a `DashboardEvent` round-trips without
/// the core having to know every event's concrete `data` shape up front.
public enum JSONValue: Codable, Sendable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let o = try? c.decode([String: JSONValue].self) {
            self = .object(o)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    // Convenience accessors used by the chat reducer / UI.
    public var stringValue: String? { if case .string(let s) = self { return s } else { return nil } }
    public var numberValue: Double? { if case .number(let n) = self { return n } else { return nil } }
    public var boolValue: Bool? { if case .bool(let b) = self { return b } else { return nil } }
    public var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o } else { return nil } }
    public var arrayValue: [JSONValue]? { if case .array(let a) = self { return a } else { return nil } }
}

/// The uniform REST response envelope — mirrors `ApiResponse<T>` in
/// `packages/shared/src/types.ts`. `success` is optional so an endpoint that
/// returns a bare wrapped `{ data }` still decodes.
public struct ApiResponse<T: Codable & Sendable>: Codable, Sendable {
    public let success: Bool?
    public let data: T?
    public let error: String?
    public let code: String?
}
