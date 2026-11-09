#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyWire
@testable import HappyUI
import XCTest

final class ToolWordsTests: XCTestCase {
    private func tool(_ name: String, _ arguments: [String: JSONValue], status: String = "completed", presentation: AgentWire.Presentation? = nil) -> ChatItem.Tool {
        .init(name: name, status: status, presentation: presentation, arguments: .object(arguments))
    }

    func testBuiltInDescriptionsStandAloneAcrossToolKindsAndStates() {
        for name in ["exec_command", "python", "apply_patch", "write_stdin", "kill_session", "update_artifact", "update_document", "create_task", "create_bot"] {
            for status in ["running", "completed", "failed"] {
                let call = tool(name, ["description": .string("  Check\n account\t tests  ")], status: status)
                let words = ToolWords(call)
                XCTAssertEqual(words.subject, "Check account tests", name)
                XCTAssertEqual(words.verb, "", name)
                XCTAssertFalse(words.mono, name)
                XCTAssertEqual(words.glyph, ToolWords.glyph(name, presentation: nil, failed: call.failed))
            }
        }
    }

    func testExplicitFieldsAndBlankDescriptionFallbacks() {
        for (name, field, expected) in [
            ("send_agent_message", "explanation", "Share findings"),
            ("create_artifact", "title", "Usage report"),
            ("create_task", "name", "Investigate startup"),
            ("read_vault_file", "path", "notes/plan.md"),
            ("web_search", "query", "Swift actors"),
            ("web_fetch", "url", "https://example.com"),
            ("create_todo", "text", "Review the report")
        ] {
            XCTAssertEqual(ToolWords(tool(name, ["description": .string(" \n "), field: .string(expected)])).subject, expected)
        }
        XCTAssertEqual(ToolWords(tool("update_artifact", ["description": .string("Refresh the chart"), "title": .string("Old title")])).subject, "Refresh the chart")
        XCTAssertEqual(ToolWords(tool("lookup_secret", ["name": .string("PRIVATE_KEY"), "title": .string("Not a label")])).subject, ToolWords.humanize("lookup_secret"))
        XCTAssertEqual(ToolWords(tool("python", [:])).subject, ToolWords.humanize("python"))
        XCTAssertEqual(ToolWords(tool("python", ["description": .number(42)])).subject, ToolWords.humanize("python"))
    }

    func testSummaryLimitUsesUnicodeScalars() {
        let text = String(repeating: "e\u{301}", count: 100)
        let subject = ToolWords(tool("python", ["description": .string(text)])).subject
        XCTAssertEqual(subject.unicodeScalars.count, 120)
        XCTAssertEqual(subject, String(repeating: "e\u{301}", count: 60))
    }

    func testMCPDescriptionIsNotADisplayLabelAndIdentityIsPreserved() throws {
        let name = "mcp__docs__exec__command_0123456789abcdef"
        let words = ToolWords(tool(name, ["description": .string("Semantic input"), "title": .string("Also input")]))
        XCTAssertEqual(words.subject, "docs · exec__command_0123456789abcdef")
        let presentation = try JSONDecoder().decode(AgentWire.Presentation.self, from: Data(#"{"type":"exec_command","command":"native operation"}"#.utf8))
        XCTAssertEqual(ToolWords(tool(name, ["description": .string("Semantic input")], presentation: presentation)).subject, words.subject)
    }

    func testPlanKeepsItsProgressAndExplanation() {
        let call = tool("update_plan", ["explanation": .string("Investigate startup"), "plan": .array([
            .object(["step": .string("Read"), "status": .string("completed")]),
            .object(["step": .string("Fix"), "status": .string("in_progress")])
        ])])
        let words = ToolWords(call)
        XCTAssertTrue(words.subject.contains("Investigate startup"))
        XCTAssertTrue(words.subject.contains(ToolWords.plan(call)!))
    }

    func testDecodedRichCommandKeepsItsSummaryAndDetailBody() throws {
        let data = Data(#"{"type":"tool_call","id":"c","name":"exec_command","status":"completed","arguments":{"description":"Run account tests","cmd":"swift test"},"presentation":{"type":"exec_command","command":"swift test","output":"Passed"}}"#.utf8)
        guard case .toolCall(let id, let name, let status, let presentation, let arguments, _, let result, _) = try JSONDecoder().decode(AgentWire.Block.self, from: data) else { return XCTFail() }
        let call = ChatItem.Tool(name: name, status: status, presentation: presentation, callId: id, arguments: arguments, result: result)
        XCTAssertEqual(ToolWords(call).subject, "Run account tests")
        XCTAssertEqual(ToolWords(call).verb, "")
        XCTAssertEqual(ToolDetail(call).sections, [.terminal(command: "swift test", output: "Passed", prompt: true)])
        XCTAssertFalse(ToolDetail(call).wantsFullData)
    }

    func testRichRowsKeepDiffCountsMediaAndTerminalBodies() throws {
        let patch = try JSONDecoder().decode(AgentWire.Presentation.self, from: Data(#"{"type":"file_diff","files":[{"path":"a.swift","kind":"update","added":3,"deleted":1},{"path":"b.swift","kind":"add","added":2}]}"#.utf8))
        let call = tool("apply_patch", ["description": .string("Update both account tests")], presentation: patch)
        let words = ToolWords(call)
        XCTAssertEqual(words.subject, "Update both account tests")
        XCTAssertEqual(words.added, 5)
        XCTAssertEqual(words.deleted, 1)
        XCTAssertEqual(words.glyph, .ionicons("document-outline"))
        XCTAssertTrue(call.isResult)
        XCTAssertEqual(ToolDetail(call).sections, ToolDetail(.init(name: call.name, status: call.status, presentation: patch)).sections)

        for (name, json) in [
            ("write_stdin", #"{"type":"background_terminal_interaction","command":"python","input":"print(2)\n","output":"2"}"#),
            ("codex_imagegen", #"{"type":"media","items":[{"kind":"image","name":"chart.png","mimeType":"image/png"}]}"#)
        ] {
            let presentation = try JSONDecoder().decode(AgentWire.Presentation.self, from: Data(json.utf8))
            let old = ChatItem.Tool(name: name, status: "completed", presentation: presentation)
            let labeled = tool(name, ["description": .string("Inspect account results")], presentation: presentation)
            XCTAssertEqual(ToolWords(labeled).subject, "Inspect account results")
            XCTAssertEqual(ToolWords(labeled).glyph, ToolWords(old).glyph)
            XCTAssertEqual(labeled.isResult, old.isResult)
            XCTAssertEqual(ToolDetail(labeled).sections, ToolDetail(old).sections)
        }
    }
}
#endif