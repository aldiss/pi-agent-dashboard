import Foundation

/// Available model info. Mirrors `ModelInfo` in `packages/shared/src/types.ts`.
public struct ModelInfo: Codable, Sendable, Equatable, Identifiable {
    public let provider: String
    public let id: String
    /// `provider/id` — the form the dashboard uses to display + set a model.
    public var qualified: String { "\(provider)/\(id)" }
    public init(provider: String, id: String) {
        self.provider = provider; self.id = id
    }
}

/// Image content for message attachments. Mirrors `ImageContent`
/// (compatible with pi SDK ImageContent): `{ type:"image", data, mimeType }`.
public struct ImageContent: Codable, Sendable, Equatable {
    public let type: String
    public let data: String      // base64
    public let mimeType: String
    public init(data: String, mimeType: String) {
        self.type = "image"; self.data = data; self.mimeType = mimeType
    }
}

/// A CodingKey whose name is computed at runtime — lets the protocol encoders
/// emit `{ type, ... }` objects with arbitrary keys.
struct DynamicKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
    init(_ s: String) { self.stringValue = s }
}
