import Foundation

/// PromptBus request payload (`prompt_request.prompt`).
public struct DashboardPromptSpec: Sendable, Equatable, Decodable {
    public let question: String
    public let method: String
    public let options: [String]
    public let defaultValue: String?
    public let pipeline: String?
    public let metadata: [String: JSONValue]

    private enum K: String, CodingKey {
        case question, type, options, defaultValue, pipeline, metadata
    }

    public init(question: String, method: String, options: [String] = [],
                defaultValue: String? = nil, pipeline: String? = nil,
                metadata: [String: JSONValue] = [:]) {
        self.question = question
        self.method = method
        self.options = options
        self.defaultValue = defaultValue
        self.pipeline = pipeline
        self.metadata = metadata
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        question = try c.decodeIfPresent(String.self, forKey: .question) ?? "Question"
        method = try c.decodeIfPresent(String.self, forKey: .type) ?? "select"
        options = try c.decodeIfPresent([String].self, forKey: .options) ?? []
        defaultValue = try c.decodeIfPresent(String.self, forKey: .defaultValue)
        pipeline = try c.decodeIfPresent(String.self, forKey: .pipeline)
        metadata = try c.decodeIfPresent([String: JSONValue].self, forKey: .metadata) ?? [:]
    }
}

/// Optional PromptBus renderer claim. Native uses the protocol-level prompt fields
/// for built-in controls and keeps this claim for graceful custom-component fallback.
public struct DashboardPromptComponent: Sendable, Equatable, Decodable {
    public let type: String
    public let props: [String: JSONValue]

    public init(type: String, props: [String: JSONValue] = [:]) {
        self.type = type
        self.props = props
    }

    private enum K: String, CodingKey { case type, props }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "generic-dialog"
        props = try c.decodeIfPresent([String: JSONValue].self, forKey: .props) ?? [:]
    }
}

/// One pending PromptBus interaction. Stable identity is `(sessionId,promptId)`;
/// `promptId` alone is unique within a session, which is how the server routes replies.
public struct DashboardPromptRequest: Sendable, Equatable, Identifiable, Decodable {
    public let sessionId: String
    public let promptId: String
    public let prompt: DashboardPromptSpec
    public let component: DashboardPromptComponent
    public let placement: String

    public var id: String { promptId }

    public init(sessionId: String, promptId: String, prompt: DashboardPromptSpec,
                component: DashboardPromptComponent, placement: String) {
        self.sessionId = sessionId
        self.promptId = promptId
        self.prompt = prompt
        self.component = component
        self.placement = placement
    }

    private enum K: String, CodingKey {
        case sessionId, promptId, prompt, component, placement
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        promptId = try c.decode(String.self, forKey: .promptId)
        prompt = try c.decode(DashboardPromptSpec.self, forKey: .prompt)
        component = try c.decode(DashboardPromptComponent.self, forKey: .component)
        placement = try c.decodeIfPresent(String.self, forKey: .placement) ?? "inline"
    }

    /// Secondary explanatory text carried by `ask_user` in prompt metadata.
    public var message: String? { prompt.metadata["message"]?.stringValue }
}

/// Pure PromptBus presentation rules shared by SwiftUI and protocol tests.
public enum PromptPresentation {
    /// `ask_user(input)` sends its placeholder through `defaultValue`; it is UI hint
    /// text, never an answer. Editor content is a genuine prefill.
    public static func initialText(method: String, defaultValue: String?) -> String {
        method.lowercased() == "editor" ? (defaultValue ?? "") : ""
    }

    /// PWA treats an in-list option named Cancel as cancellation, not the answer
    /// string "Cancel". Case/outer whitespace are presentation details.
    public static func isCancelOption(_ option: String) -> Bool {
        option.trimmingCharacters(in: .whitespacesAndNewlines)
            .caseInsensitiveCompare("cancel") == .orderedSame
    }

    /// Toggle all multiselect options in stable option order.
    public static func toggledAll(current: Set<String>, options: [String]) -> Set<String> {
        let all = Set(options)
        return all.isSubset(of: current) ? [] : all
    }
}
