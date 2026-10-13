import XCTest
import HappyWire
@testable import HappyCore

// Expected values follow ToolView.tsx, knownTools.tsx and
// PermissionFooter.tsx on the same inputs.

private let words = ToolActionWords(ran: "Ran", edited: "Edited", read: "Read", searched: "Searched", fetched: "Fetched", ranTask: "Ran task")

private func tool(
    _ name: String, _ input: JSONValue = .object([:]), state: ToolCall.State = .completed, description: String? = nil,
    result: JSONValue? = nil, permission: ToolPermission? = nil
) -> ToolCall {
    ToolCall(name: name, state: state, input: input, createdAt: 0, description: description, result: result, permission: permission)
}

private func present(_ tool: ToolCall, children: [ChatMessage] = [], root: String? = "/repo", flavor: String? = nil, compact: Bool = false) -> ToolPresentation {
    ChatToolPresentation.present(tool, children: children, context: ToolContext(root: root, flavor: flavor, compactMode: compact), words: words)!
}

final class ChatToolPresentationTests: XCTestCase {
    func testKnownToolsTitleTheirHeaders() {
        XCTAssertEqual(present(tool("Read", ["file_path": "/repo/src/a.swift"])).title, .literal("src/a.swift"))
        XCTAssertEqual(present(tool("LS", ["path": "/repo"])).title, .literal("<root>"))
        XCTAssertEqual(present(tool("LS", ["path": "/repository/x"])).title, .literal("/repository/x"))
        XCTAssertEqual(present(tool("Grep", ["pattern": "TODO"])).title, .literal("grep(pattern: TODO)"))
        XCTAssertEqual(present(tool("Bash", ["command": "ls"], description: "List")).title, .literal("List"))
        XCTAssertEqual(present(tool("Bash", ["command": "ls"])).title, .name(.terminal))
        XCTAssertEqual(present(tool("WebFetch", ["url": "https://Docs.Swift.org/x"])).title, .literal("docs.swift.org"))
        XCTAssertEqual(present(tool("WebFetch", ["url": "not a url"])).title, .name(.fetchUrl))
        XCTAssertEqual(present(tool("Task", ["description": "Explore"])).title, .literal("Explore"))
        XCTAssertEqual(present(tool("TodoWrite")).title, .name(.todoList))
        XCTAssertEqual(present(tool("execute", ["toolCall": ["title": "rm a.txt [current working directory /w] (Remove it)"]])).title, .literal("rm a.txt"))
        XCTAssertEqual(present(tool("mcp__linear__create_issue")).title, .literal("MCP: Linear Create Issue"))
        XCTAssertEqual(present(tool("mcp__linear__create_issue")).icon, .mcp)
        XCTAssertEqual(present(tool("AskUserQuestion", ["questions": [["header": "Scope", "question": "Which?"]]])).title, .literal("Scope"))
        XCTAssertEqual(present(tool("request_user_input", ["input": ["questions": [["question": "Name?"]]]])).title, .name(.question))
        // A tool with no knownTools entry keeps toolDisplay's title.
        XCTAssertEqual(present(tool("read_agent_history")).title, .literal("Read agent history"))
    }

    func testSubtitlesAndTheMultiEditStatus() {
        XCTAssertEqual(present(tool("Bash", ["command": "ls -la"])).subtitle, .literal("ls -la"))
        XCTAssertEqual(present(tool("execute", ["toolCall": ["title": "rm a [cwd /w] (Remove (old) file)"]])).subtitle, nil)
        XCTAssertEqual(present(tool("execute", ["toolCall": ["title": "rm a (x (y)"]])).subtitle, .literal("x (y"))
        XCTAssertEqual(present(tool("AskUserQuestion", ["questions": [["question": "A?"], ["question": "B?"]]])).subtitle, .multipleQuestions(2))
        XCTAssertEqual(present(tool("CodexDiff", ["unified_diff": "--- a/x/y.ts\n+++ b/x/y.ts\n@@"])).subtitle, .literal("y.ts"))
        XCTAssertEqual(present(tool("CodexPatch", ["changes": ["/repo/a/one.ts": ["add": ["content": "x"]], "/repo/b.ts": ["add": ["content": "y"]]]])).subtitle,
                       .modifyingMultipleFiles(file: "one.ts", count: 1))
        let long = String(repeating: "x", count: 60)
        XCTAssertEqual(present(tool("CodexBash", ["parsed_cmd": [["type": "read", "cmd": .string(long), "name": "/repo/f"]]])).subtitle,
                       .literal(String(repeating: "x", count: 50) + "..."))
        let multi = present(tool("MultiEdit", ["file_path": "/repo/a.ts", "edits": [["old_string": "a"], ["old_string": "b"]]]))
        XCTAssertEqual(multi.title, .multiEditEdits(path: "a.ts", count: 2))
        XCTAssertEqual(multi.status, .multiEditEdits(path: "a.ts", count: 2))
        XCTAssertEqual(present(tool("MultiEdit", ["file_path": "/repo/a.ts", "edits": [["old_string": "a"]]])).title, .literal("a.ts"))
    }

    func testWhichToolsGetACard() {
        // Minimal and terminal tools are one-line rows; a pending one keeps
        // its buttons under the row.
        let bash = present(tool("Bash", ["command": "ls"], state: .running, permission: ToolPermission(id: "p", status: .pending)))
        XCTAssertEqual(bash.form, .compact)
        XCTAssertTrue(bash.showsPermissionFooter)
        XCTAssertEqual(bash.statusGlyph, .spinner)
        XCTAssertTrue(bash.showsElapsed)
        XCTAssertEqual(present(tool("Read", ["file_path": "/x"])).form, .compact)
        XCTAssertEqual(present(tool("Edit", ["file_path": "/repo/a", "old_string": "a", "new_string": "b"])).form, .card)
        XCTAssertEqual(present(tool("Edit", ["file_path": "/repo/a"]), compact: true).form, .compact)
        XCTAssertEqual(present(tool("Edit", ["file_path": "/repo/a"])).opensFile, "/repo/a")
        XCTAssertEqual(present(tool("TodoWrite", ["todos": []])).form, .compact)
        XCTAssertEqual(present(tool("TodoWrite", ["todos": [["content": "a", "status": "pending"]]])).form, .card)
        // A task opens up once its agent has run a tool.
        XCTAssertEqual(present(tool("Task", ["description": "x"])).form, .compact)
        let child = ChatMessage.toolCall(ToolCallMessage(id: "c", createdAt: 0, tool: tool("Read")))
        XCTAssertEqual(present(tool("Task", ["description": "x"]), children: [child]).form, .card)
        // An unknown tool waiting for approval shows its arguments.
        let pending = present(tool("frobnicate", ["level": 3], state: .running, permission: ToolPermission(id: "p", status: .pending)))
        XCTAssertEqual(pending.form, .card)
        XCTAssertEqual(pending.body, .raw(input: "{\n  \"level\": 3\n}", output: nil))
        XCTAssertEqual(pending.icon, .generic)
        // Gemini's unlisted tools are rows; patch tools have no card header.
        XCTAssertEqual(present(tool("Edit", ["file_path": "/a"]), flavor: "gemini").form, .card)
        XCTAssertEqual(present(tool("glob_files"), flavor: "gemini").form, .compact)
        XCTAssertFalse(present(tool("CodexPatch", ["changes": [:]])).showsHeader)
        XCTAssertEqual(present(tool("file")).form, .inline)
        XCTAssertNil(ChatToolPresentation.present(tool("ToolSearch"), context: ToolContext(), words: words))
    }

    func testErrorsAndStoppedTools() {
        let refused = present(tool("Write", ["file_path": "/a"], state: .error, result: "<tool_use_error>File has not been read yet.</tool_use_error>"))
        XCTAssertEqual(refused.form, .compact)
        XCTAssertEqual(refused.statusGlyph, .stopped)
        let failed = present(tool("Write", ["file_path": "/a", "content": "x"], state: .error, result: "disk full"))
        XCTAssertEqual(failed.form, .card)
        XCTAssertEqual(failed.statusGlyph, .failed)
        XCTAssertEqual(failed.body, .view(.write, error: "disk full"))
        let denied = present(tool("Write", ["file_path": "/a"], state: .error, result: "no", permission: ToolPermission(id: "p", status: .denied)))
        XCTAssertEqual(denied.statusGlyph, .stopped)
        XCTAssertEqual(denied.body, .view(.write, error: nil))
        // Patch tools hide the stock error; a tool without a view shows it alone.
        XCTAssertEqual(present(tool("CodexPatch", ["changes": [:]], state: .error, result: "bad")).body, .view(.codexPatch, error: nil))
        XCTAssertEqual(present(tool("frobnicate", state: .error, result: "boom", permission: ToolPermission(id: "p", status: .pending))).body, .error("boom"))
        let done = present(tool("frobnicate", ["a": ["b", .bool(true), .null]], result: ["ok": 1], permission: ToolPermission(id: "p", status: .pending)))
        XCTAssertEqual(done.body, .raw(input: "{\n  \"a\": [\n    \"b\",\n    true,\n    null\n  ]\n}", output: "{\n  \"ok\": 1\n}"))
        XCTAssertEqual(ChatToolPresentation.toolUseError("x <tool_use_error>\n line one\nline two </tool_use_error>"), "line one\nline two")
        XCTAssertEqual(ChatToolPresentation.pretty(["s": "a\"b\n\u{1}"]), "{\n  \"s\": \"a\\\"b\\n\\u0001\"\n}")
        XCTAssertEqual(ChatToolPresentation.pretty(["e": [:], "f": [], "n": .number(1.5)]), "{\n  \"e\": {},\n  \"f\": [],\n  \"n\": 1.5\n}")
    }

    func testCodexBashIconsFollowTheParsedCommand() {
        XCTAssertEqual(present(tool("CodexBash", ["parsed_cmd": [["type": "read", "name": "/repo/f"]]])).icon, .read)
        XCTAssertEqual(present(tool("CodexBash", ["parsed_cmd": [["type": "read", "name": "/repo/f"]]])).title, .literal("f"))
        XCTAssertEqual(present(tool("CodexBash", ["parsed_cmd": [["type": "write"]]])).icon, .edit)
        XCTAssertEqual(present(tool("CodexBash", ["command": "ls"])).icon, .terminal)
        XCTAssertEqual(present(tool("Grep", ["pattern": "x"])).icon, .read)
        XCTAssertEqual(present(tool("exec_command")).icon, .terminal)
    }
}

final class ChatPermissionButtonsTests: XCTestCase {
    private func kinds(_ name: String, flavor: String? = nil) -> [PermissionButton.Kind] {
        ChatPermissionButtons.buttons(ToolPermission(id: "p", status: .pending), toolName: name, toolInput: [:], flavor: flavor).map(\.kind)
    }

    func testEachToolOffersItsButtons() {
        XCTAssertEqual(kinds("Bash"), [.allow, .allowForTool, .deny])
        XCTAssertEqual(kinds("Edit"), [.allow, .allowAllEdits, .deny])
        XCTAssertEqual(kinds("ExitPlanMode"), [.allow, .allowAllEdits, .allowEverything, .deny])
        XCTAssertEqual(kinds("Bash", flavor: "codex"), [.codexAllow, .codexAllowForSession, .codexAbort])
        XCTAssertEqual(kinds("CodexBash"), [.codexAllow, .codexAllowForSession, .codexAbort])
        let pending = ChatPermissionButtons.buttons(ToolPermission(id: "p", status: .pending), toolName: "Bash", toolInput: [:], flavor: nil)
        XCTAssertEqual(pending.map(\.maxLines), [1, 2, 2])
        XCTAssertFalse(pending.contains { $0.selected || $0.inactive })
    }

    func testAnAnsweredRequestMarksTheButtonUsed() {
        let input: JSONValue = ["command": "git status"]
        let forTool = ChatPermissionButtons.buttons(
            ToolPermission(id: "p", status: .approved, allowedTools: ["Bash(git status)"]), toolName: "Bash", toolInput: input, flavor: nil
        )
        XCTAssertEqual(forTool.map(\.selected), [false, true, false])
        XCTAssertEqual(forTool.map(\.inactive), [true, false, true])
        let allEdits = ChatPermissionButtons.buttons(ToolPermission(id: "p", status: .approved, mode: "acceptEdits"), toolName: "Edit", toolInput: [:], flavor: nil)
        XCTAssertEqual(allEdits.map(\.selected), [false, true, false])
        let denied = ChatPermissionButtons.buttons(ToolPermission(id: "p", status: .denied), toolName: "Edit", toolInput: [:], flavor: nil)
        XCTAssertEqual(denied.map(\.selected), [false, false, true])
        XCTAssertEqual(denied.map(\.inactive), [true, true, false])
        let canceled = ChatPermissionButtons.buttons(ToolPermission(id: "p", status: .canceled), toolName: "Edit", toolInput: [:], flavor: nil)
        XCTAssertFalse(canceled.contains { $0.selected || $0.inactive })
        let codex = ChatPermissionButtons.buttons(ToolPermission(id: "p", status: .approved), toolName: "CodexBash", toolInput: [:], flavor: nil)
        XCTAssertEqual(codex.map(\.selected), [true, false, false])
        XCTAssertEqual(codex.map(\.inactive), [false, true, true])
    }

    func testRepliesCarryTheChoice() {
        XCTAssertEqual(ChatPermissionButtons.reply(.allowForTool, toolName: "Bash", toolInput: ["command": "ls"]), PermissionReply(allow: true, allowedTools: ["Bash(ls)"]))
        XCTAssertEqual(ChatPermissionButtons.reply(.allowForTool, toolName: "Grep", toolInput: [:]), PermissionReply(allow: true, allowedTools: ["Grep"]))
        XCTAssertEqual(ChatPermissionButtons.reply(.allow, toolName: "ExitPlanMode", toolInput: [:]), PermissionReply(allow: true, permissionMode: "default"))
        XCTAssertEqual(ChatPermissionButtons.reply(.allowAllEdits, toolName: "Edit", toolInput: [:]), PermissionReply(allow: true, mode: "acceptEdits", permissionMode: "acceptEdits"))
        XCTAssertEqual(ChatPermissionButtons.reply(.codexAbort, toolName: "CodexBash", toolInput: [:]), PermissionReply(allow: false, decision: .abort))
    }
}
