import HappyCore
import HappyWire
import XCTest

final class ToolSummaryTests: XCTestCase {
    func testTheFiftyBuiltInDisplayFieldsMatchTheServerContract() {
        let names = """
        Bash exec_command run_terminal_command python apply_patch BashInput TaskInput send_command_input write_stdin
        BashStop TaskStop kill_command_or_subagent kill_session archive_agent archive_subtask archive_task interrupt_agent
        delete_permanently preview_delete delete_artifact delete_calendar_event delete_todo update_artifact update_calendar_event
        update_document update_surface update_todo reorder_todo write_artifact_data restore_vault_file restore_vault_folder
        add_surface_user remove_surface_user attach_secret detach_secret reference_secret attach_compute detach_compute
        attach_repository add_mcp_server update_mcp_server set_mcp_server_enabled set_bot_avatar set_node_avatar cancel_ask
        message_task create_task create_bot create_calendar_event codex_imagegen
        """.split(whereSeparator: \.isWhitespace).map(String.init)
        XCTAssertEqual(Set(names).count, 50)
        for name in names {
            XCTAssertEqual(ToolSummary.text(name: name, arguments: .object(["description": .string("  Run\naccount tests  ")])), "Run account tests", name)
        }
    }

    func testSemanticArgumentsAreNotMistakenForLabels() {
        for name in ["lookup_secret", "unknown_tool", "mcp__docs__python_0123456789abcdef"] {
            XCTAssertNil(ToolSummary.text(name: name, arguments: .object([
                "description": .string("Semantic input"), "name": .string("PRIVATE_KEY"),
                "title": .string("Input title"), "prompt": .string("Not a label"), "body": .string("Not a label")
            ])))
        }
    }

    func testMappedFallbacksSkipBlankAndNonStringValues() {
        XCTAssertEqual(ToolSummary.text(name: "create_task", arguments: .object(["description": .string("\n\t"), "name": .string(" Check\tstartup ")])), "Check startup")
        XCTAssertEqual(ToolSummary.text(name: "update_artifact", arguments: .object(["description": .number(3), "title": .string("Report")])), "Report")
        XCTAssertEqual(ToolSummary.text(name: "move_vault_file", arguments: .object(["path": .string(" "), "toPath": .string("notes/plan.md")])), "notes/plan.md")
        XCTAssertEqual(ToolSummary.text(name: "send_agent_message", arguments: .object(["explanation": .string("Share findings"), "title": .string("Ignored")])), "Share findings")
    }

    func testAQuestionUsesItsFirstNonBlankQuestionNotContextOrAnswers() {
        let arguments: JSONValue = .object(["context": .string("Not the label"), "questions": .array([
            .object(["question": .string(" \n ")]), .object(["question": .string(" Which\nbranch? ")])
        ])])
        XCTAssertEqual(ToolSummary.text(name: "request_user_input", arguments: arguments), "Which branch?")
    }

    func testNormalizationUsesWhitespaceAndUnicodeScalarRules() {
        XCTAssertNil(ToolSummary.normalized(" \t\n\u{00A0}"))
        XCTAssertEqual(ToolSummary.normalized(" First\u{00A0}second\nthird "), "First second third")
        let text = String(repeating: "👩‍💻", count: 60)
        XCTAssertEqual(ToolSummary.normalized(text)?.unicodeScalars.count, 120)
        XCTAssertEqual(ToolSummary.normalized(text), String(repeating: "👩‍💻", count: 40))
    }
}