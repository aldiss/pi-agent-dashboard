import XCTest
@testable import PiDashboardKit

/// Wire coverage for the model-picker contract the store emits/consumes:
/// `request_models` / `set_model` / `set_thinking_level` encode, `models_list`
/// decode → `[ModelInfo]`, and `ModelInfo.qualified`. (ProtocolTests already covers
/// `set_model`; this adds the rest the picker depends on.) The DashboardStore lives
/// in the app target, so its method wiring is covered indirectly here by pinning the
/// exact ClientMessage/ServerMessage shapes those methods route through `safeSend`.
final class ModelPickerWireTests: XCTestCase {

    private func encodeObject(_ m: ClientMessage) throws -> [String: Any] {
        let data = try JSONEncoder().encode(m)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testRequestModelsEncodes() throws {
        let o = try encodeObject(.requestModels(sessionId: "s1"))
        XCTAssertEqual(o["type"] as? String, "request_models")
        XCTAssertEqual(o["sessionId"] as? String, "s1")
    }

    func testSetThinkingLevelEncodes() throws {
        let o = try encodeObject(.setThinkingLevel(sessionId: "s1", level: "high"))
        XCTAssertEqual(o["type"] as? String, "set_thinking_level")
        XCTAssertEqual(o["sessionId"] as? String, "s1")
        XCTAssertEqual(o["level"] as? String, "high")
    }

    func testSetModelEncodes() throws {
        let o = try encodeObject(.setModel(sessionId: "s1", provider: "anthropic", modelId: "claude-opus-4"))
        XCTAssertEqual(o["type"] as? String, "set_model")
        XCTAssertEqual(o["provider"] as? String, "anthropic")
        XCTAssertEqual(o["modelId"] as? String, "claude-opus-4")
    }

    func testModelsListDecodesIntoModelInfo() throws {
        let json = #"""
        {"type":"models_list","sessionId":"s1","models":[
          {"provider":"anthropic","id":"claude-opus-4"},
          {"provider":"openai","id":"gpt-5"}
        ]}
        """#
        let msg = try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
        guard case .modelsList(let sid, let models) = msg else {
            return XCTFail("expected models_list, got \(msg.wireType)")
        }
        XCTAssertEqual(sid, "s1")
        XCTAssertEqual(models.count, 2)
        XCTAssertEqual(models[0].qualified, "anthropic/claude-opus-4")
        XCTAssertEqual(models[1].qualified, "openai/gpt-5")
    }

    func testModelsListEmptyDecodes() throws {
        let msg = try JSONDecoder().decode(
            ServerMessage.self, from: Data(#"{"type":"models_list","sessionId":"s1"}"#.utf8))
        guard case .modelsList(_, let models) = msg else { return XCTFail("expected models_list") }
        XCTAssertTrue(models.isEmpty)
    }

    func testModelInfoQualified() {
        XCTAssertEqual(ModelInfo(provider: "anthropic", id: "claude-sonnet-4").qualified,
                       "anthropic/claude-sonnet-4")
    }
}
