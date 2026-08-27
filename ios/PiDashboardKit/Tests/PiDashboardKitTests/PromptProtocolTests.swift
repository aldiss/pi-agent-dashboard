import XCTest
@testable import PiDashboardKit

final class PromptProtocolTests: XCTestCase {
    func testPromptRequestDecodesProtocolFields() throws {
        let json = #"""
        {
          "type":"prompt_request",
          "sessionId":"s1",
          "promptId":"p1",
          "prompt":{
            "question":"Choose target",
            "type":"select",
            "options":["A","B"],
            "defaultValue":"B",
            "pipeline":"ask-user",
            "metadata":{"message":"Used for deployment","toolCallId":"t1"}
          },
          "component":{"type":"generic-dialog","props":{"tone":"warning"}},
          "placement":"inline"
        }
        """#
        let decoded = try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
        guard case .promptRequest(let request) = decoded else {
            return XCTFail("expected prompt_request, got \(decoded.wireType)")
        }
        XCTAssertEqual(request.sessionId, "s1")
        XCTAssertEqual(request.promptId, "p1")
        XCTAssertEqual(request.prompt.question, "Choose target")
        XCTAssertEqual(request.prompt.method, "select")
        XCTAssertEqual(request.prompt.options, ["A", "B"])
        XCTAssertEqual(request.prompt.defaultValue, "B")
        XCTAssertEqual(request.prompt.pipeline, "ask-user")
        XCTAssertEqual(request.message, "Used for deployment")
        XCTAssertEqual(request.prompt.metadata["toolCallId"]?.stringValue, "t1")
        XCTAssertEqual(request.component.type, "generic-dialog")
        XCTAssertEqual(request.component.props["tone"]?.stringValue, "warning")
        XCTAssertEqual(request.placement, "inline")
    }

    func testPromptDismissAndCancelDecode() throws {
        for (type, expectedCancel) in [("prompt_dismiss", false), ("prompt_cancel", true)] {
            let json = "{\"type\":\"\(type)\",\"sessionId\":\"s\",\"promptId\":\"p\"}"
            let decoded = try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
            switch decoded {
            case .promptDismiss(let sid, let pid):
                XCTAssertFalse(expectedCancel); XCTAssertEqual(sid, "s"); XCTAssertEqual(pid, "p")
            case .promptCancel(let sid, let pid):
                XCTAssertTrue(expectedCancel); XCTAssertEqual(sid, "s"); XCTAssertEqual(pid, "p")
            default:
                XCTFail("unexpected \(decoded.wireType)")
            }
        }
    }

    func testPromptResponseEncodesSelectAnswer() throws {
        let json = try object(.promptResponse(
            sessionId: "s1", promptId: "p1", answer: "B",
            cancelled: false, source: "dashboard-default"))
        XCTAssertEqual(json["type"] as? String, "prompt_response")
        XCTAssertEqual(json["sessionId"] as? String, "s1")
        XCTAssertEqual(json["promptId"] as? String, "p1")
        XCTAssertEqual(json["answer"] as? String, "B")
        XCTAssertEqual(json["cancelled"] as? Bool, false)
        XCTAssertEqual(json["source"] as? String, "dashboard-default")
    }

    func testPromptResponseEncodesMultiselectAsJSONArrayString() throws {
        let values = ["A", "C"]
        let answer = String(decoding: try JSONEncoder().encode(values), as: UTF8.self)
        let json = try object(.promptResponse(
            sessionId: "s", promptId: "p", answer: answer,
            cancelled: false, source: "dashboard-default"))
        XCTAssertEqual(json["answer"] as? String, #"["A","C"]"#)
    }

    func testCancelledPromptOmitsAnswer() throws {
        let json = try object(.promptResponse(
            sessionId: "s", promptId: "p", answer: nil,
            cancelled: true, source: "dashboard-default"))
        XCTAssertNil(json["answer"])
        XCTAssertEqual(json["cancelled"] as? Bool, true)
    }

    func testInputPlaceholderIsNotInitialAnswerButEditorDefaultIs() {
        XCTAssertEqual(PromptPresentation.initialText(
            method: "input", defaultValue: "e.g. Alice"), "")
        XCTAssertEqual(PromptPresentation.initialText(
            method: "editor", defaultValue: "prefilled body"), "prefilled body")
    }

    func testCancelOptionMatchesPWAEncodingRule() {
        XCTAssertTrue(PromptPresentation.isCancelOption("Cancel"))
        XCTAssertTrue(PromptPresentation.isCancelOption("  cancel\n"))
        XCTAssertFalse(PromptPresentation.isCancelOption("Cancel operation later"))
    }

    func testMultiselectToggleAllSelectsThenClearsEveryOption() {
        let options = ["A", "B", "C"]
        let all = PromptPresentation.toggledAll(current: ["A"], options: options)
        XCTAssertEqual(all, Set(options))
        XCTAssertTrue(PromptPresentation.toggledAll(current: all, options: options).isEmpty)
    }

    private func object(_ message: ClientMessage) throws -> [String: Any] {
        let data = try JSONEncoder().encode(message)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
