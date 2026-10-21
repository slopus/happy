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

private func present(
    _ tool: ToolCall, children: [ChatMessage] = [], root: String? = "/repo", flavor: String? = nil, compact: Bool = false, expanded: Bool = false
) -> ToolPresentation {
    ChatToolPresentation.present(
        tool, children: children, context: ToolContext(root: root, flavor: flavor, compactMode: compact),
        state: ToolDisplayState(expanded: expanded), words: words
    )!
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
        XCTAssertTrue(present(tool("CodexPatch", ["changes": [:]])).showsHeader)
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
        XCTAssertEqual(failed.expandedBody, .view(.write, error: "disk full"))
        let denied = present(tool("Write", ["file_path": "/a"], state: .error, result: "no", permission: ToolPermission(id: "p", status: .denied)))
        XCTAssertEqual(denied.statusGlyph, .stopped)
        XCTAssertEqual(denied.expandedBody, .view(.write, error: nil))
        // Patch tools hide the stock error; a tool without a view shows it alone.
        XCTAssertEqual(present(tool("CodexPatch", ["changes": [:]], state: .error, result: "bad")).expandedBody, .view(.codexPatch, error: nil))
        XCTAssertEqual(present(tool("frobnicate", state: .error, result: "boom", permission: ToolPermission(id: "p", status: .pending)), expanded: true).body, .error("boom"))
        let done = present(tool("frobnicate", ["a": ["b", .bool(true), .null]], result: ["ok": 1], permission: ToolPermission(id: "p", status: .pending)))
        XCTAssertEqual(done.expandedBody, .raw(input: "{\n  \"a\": [\n    \"b\",\n    true,\n    null\n  ]\n}", output: "{\n  \"ok\": 1\n}"))
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

/// Tool output is collapsed by default (a deliberate difference from
/// happy-app): only the header shows until the reader taps it, except for
/// what a pending decision needs.
final class ChatToolCollapseTests: XCTestCase {
    private let edit: JSONValue = ["file_path": "/repo/a.swift", "old_string": "let a = 1", "new_string": "let a = 2"]

    func testACompletedBashShowsOnlyItsHeader() {
        let bash = present(tool("Bash", ["command": "swift build"], result: ["stdout": "Build complete!", "stderr": ""]))
        XCTAssertEqual(bash.form, .compact)
        XCTAssertEqual(bash.body, .none)
        XCTAssertEqual(bash.expandedBody, .view(.bash, error: nil))
        XCTAssertFalse(bash.awaitingDecision)
    }

    func testACompletedEditKeepsItsDiffClosed() {
        let completed = present(tool("Edit", edit, result: "The file has been updated."))
        XCTAssertEqual(completed.form, .card)
        XCTAssertTrue(completed.showsHeader)
        XCTAssertEqual(completed.title, .literal("a.swift"))
        XCTAssertEqual(completed.body, .none)
        XCTAssertEqual(completed.expandedBody, .view(.edit, error: nil))
    }

    func testAFailedEditShowsNoErrorText() {
        let failed = present(tool("Edit", edit, state: .error, result: "String not found in file"))
        XCTAssertEqual(failed.statusGlyph, .failed)
        XCTAssertEqual(failed.body, .none)
        XCTAssertEqual(failed.expandedBody, .view(.edit, error: "String not found in file"))
    }

    func testACompletedUnknownToolShowsNoOutput() {
        let unknown = present(tool("frobnicate", ["level": 3], result: "frobnicated"))
        XCTAssertEqual(unknown.form, .compact)
        XCTAssertEqual(unknown.body, .none)
        XCTAssertEqual(unknown.expandedBody, .raw(input: "{\n  \"level\": 3\n}", output: "frobnicated"))
    }

    func testTodosAndTasksStayClosed() {
        let todos = present(tool("TodoWrite", ["todos": [["content": "Ship", "status": "in_progress"]]]))
        XCTAssertEqual(todos.form, .card)
        XCTAssertEqual(todos.body, .none)
        XCTAssertEqual(todos.expandedBody, .view(.todo, error: nil))
        let child = ChatMessage.toolCall(ToolCallMessage(id: "c", createdAt: 0, tool: tool("Read", ["file_path": "/repo/x"])))
        let task = present(tool("Task", ["description": "Explore"], result: "Found it."), children: [child])
        XCTAssertEqual(task.form, .card)
        XCTAssertEqual(task.body, .none)
        XCTAssertEqual(task.expandedBody, .view(.task, error: nil))
        // A task whose agent ran nothing has nothing to open.
        XCTAssertEqual(present(tool("Task", ["description": "Explore"])).expandedBody, .none)
        XCTAssertEqual(present(tool("TodoWrite", ["todos": []])).expandedBody, .none)
    }

    func testAPendingPermissionShowsWhatToDecideThenClosesOnceAnswered() {
        let pendingEdit = present(tool("Edit", edit, state: .running, permission: ToolPermission(id: "p", status: .pending)))
        XCTAssertTrue(pendingEdit.awaitingDecision)
        XCTAssertEqual(pendingEdit.body, .view(.edit, error: nil))
        XCTAssertTrue(pendingEdit.showsPermissionFooter)
        let pendingBash = present(tool("Bash", ["command": "rm -rf .build"], state: .running, permission: ToolPermission(id: "p", status: .pending)))
        XCTAssertEqual(pendingBash.form, .compact)
        XCTAssertEqual(pendingBash.body, .view(.bash, error: nil))
        // An unknown tool shows its input, never an output.
        let pendingUnknown = present(tool("frobnicate", ["level": 3], state: .running, result: "partial", permission: ToolPermission(id: "p", status: .pending)))
        XCTAssertEqual(pendingUnknown.form, .card)
        XCTAssertEqual(pendingUnknown.body, .raw(input: "{\n  \"level\": 3\n}", output: nil))
        let plan = present(tool("ExitPlanMode", ["plan": "1. Do it"], state: .running, permission: ToolPermission(id: "p", status: .pending)))
        XCTAssertEqual(plan.body, .view(.exitPlan, error: nil))
        let question = present(tool("AskUserQuestion", ["questions": [["question": "Which?"]]], state: .running))
        XCTAssertTrue(question.awaitingDecision)
        XCTAssertEqual(question.body, .view(.askUserQuestion, error: nil))

        // Answered: back to the header and the settled buttons.
        let approved = present(tool("Edit", edit, result: "The file has been updated.", permission: ToolPermission(id: "p", status: .approved)))
        XCTAssertFalse(approved.awaitingDecision)
        XCTAssertEqual(approved.body, .none)
        XCTAssertTrue(approved.showsPermissionFooter)
        let denied = present(tool("Bash", ["command": "rm -rf .build"], state: .error, result: "denied", permission: ToolPermission(id: "p", status: .denied)))
        XCTAssertEqual(denied.body, .none)
        let answered = present(tool("AskUserQuestion", ["questions": [["question": "Which?"]]]))
        XCTAssertEqual(answered.body, .none)
        // Unless the reader had opened it.
        let kept = present(tool("Edit", edit, result: "The file has been updated.", permission: ToolPermission(id: "p", status: .approved)), expanded: true)
        XCTAssertEqual(kept.body, .view(.edit, error: nil))
    }

    func testAnExpandedToolShowsEverything() {
        XCTAssertEqual(present(tool("Bash", ["command": "ls"], state: .error, result: "boom"), expanded: true).body, .view(.bash, error: nil))
        XCTAssertEqual(present(tool("Edit", edit, state: .error, result: "nope"), expanded: true).body, .view(.edit, error: "nope"))
        XCTAssertEqual(present(tool("frobnicate", ["level": 3], result: ["ok": 1]), expanded: true).body,
                       .raw(input: "{\n  \"level\": 3\n}", output: "{\n  \"ok\": 1\n}"))
        XCTAssertEqual(present(tool("frobnicate", state: .error, result: "boom"), expanded: true).body, .error("boom"))
        // A refused call opens to what it tried, not to the refusal.
        let refused = present(tool("Write", ["file_path": "/repo/a", "content": "x"], state: .error, result: "<tool_use_error>Read it first.</tool_use_error>"), expanded: true)
        XCTAssertEqual(refused.form, .compact)
        XCTAssertEqual(refused.body, .view(.write, error: nil))
        // The setting still picks a row or a card.
        XCTAssertEqual(present(tool("Edit", edit), compact: true, expanded: true).form, .compact)
        XCTAssertEqual(present(tool("Edit", edit), compact: true, expanded: true).body, .view(.edit, error: nil))
    }
}

// Expected values follow [messageId].tsx, ToolHeader.tsx, ToolFullView.tsx,
// BashViewFull.tsx, CommandView.tsx and toolResult.ts.
final class ToolFullPresentationTests: XCTestCase {
    private func full(_ tool: ToolCall) -> ToolFullPresentation {
        ToolFullPresentation(tool, root: "/repo", words: words)
    }

    func testTheTitleIsTheKnownToolsUnlessTheProviderNamedTheCall() {
        XCTAssertEqual(full(tool("Read", ["file_path": "/repo/src/a.swift"])).title, .literal("src/a.swift"))
        var named = tool("Read", ["file_path": "/repo/src/a.swift"])
        named.title = "Read the config"
        XCTAssertEqual(full(named).title, .literal("Read the config"))
        XCTAssertEqual(full(tool("Bash", ["command": "ls -la"], description: "List")).title, .literal("ls -la"), "a terminal tool is titled by what it ran")
    }

    func testATerminalToolShowsItsWholeRun() {
        let done = full(tool("Bash", ["command": "swift test"], result: "Executed 3 tests\n"))
        XCTAssertEqual(done.main, .terminal(ToolFullTerminal(command: "swift test", prompt: true, stdout: "Executed 3 tests\n", stderr: nil, error: nil, hideEmptyOutput: false), controlInput: nil))
        XCTAssertNil(done.outcome, "the terminal shows the outcome itself")

        let structured = full(tool("CodexBash", ["command": ["bash", "-lc", "make"]], result: ["output": "built", "stderr": "warning: x"]))
        guard case .terminal(let run, _) = structured.main else { return XCTFail("terminal") }
        XCTAssertEqual(run.stdout, "built")
        XCTAssertEqual(run.stderr, "warning: x")

        let failed = full(tool("Bash", ["command": "false"], state: .error, result: ["error": "exit 1"]))
        guard case .terminal(let failure, _) = failed.main else { return XCTFail("terminal") }
        XCTAssertEqual(failure.error, .text("exit 1"))
        XCTAssertNil(failure.stdout)
        guard case .terminal(let silent, _) = full(tool("Bash", ["command": "false"], state: .error)).main else { return XCTFail("terminal") }
        XCTAssertEqual(silent.error, .unspecified)

        guard case .terminal(let running, _) = full(tool("Bash", ["command": "sleep 5"], state: .running)).main else { return XCTFail("terminal") }
        XCTAssertFalse(running.showsEmptyOutput, "no empty-output line while it runs")
        guard case .terminal(let quiet, _) = full(tool("Bash", ["command": "true"])).main else { return XCTFail("terminal") }
        XCTAssertTrue(quiet.showsEmptyOutput)
        guard case .terminal(let blank, _) = full(tool("Bash", ["command": "echo"], result: "  \n")).main else { return XCTFail("terminal") }
        XCTAssertNil(blank.visibleStdout, "whitespace isn't drawn")
        XCTAssertFalse(blank.showsEmptyOutput, "but it isn't nothing either")
    }

    func testAShellControlShowsItsLabelAndWhatItTyped() {
        let typed = full(tool("write_stdin", ["session_id": 7, "chars": "y\n"], result: "ok"))
        XCTAssertEqual(typed.main, .terminal(ToolFullTerminal(command: "Sending input to shell (7)", prompt: false, stdout: "ok", stderr: nil, error: nil, hideEmptyOutput: false), controlInput: "y\n"))
    }

    func testTheFallbackSections() {
        let generic = full(tool("deploy_preview", ["env": "staging"], description: "Deploy", result: ["url": "https://x"]))
        guard case .generic(let sections) = generic.main else { return XCTFail("generic") }
        XCTAssertEqual(sections.description, "Deploy")
        XCTAssertEqual(sections.input, "{\n  \"env\": \"staging\"\n}")
        XCTAssertEqual(sections.output, "{\n  \"url\": \"https://x\"\n}")
        XCTAssertNil(sections.error)
        XCTAssertFalse(sections.completedWithoutOutput)

        guard case .generic(let quiet) = full(tool("deploy_preview")).main else { return XCTFail("generic") }
        XCTAssertNil(quiet.description, "no description and no title")
        XCTAssertEqual(quiet.input, "{}", "an empty object is still shown")
        XCTAssertTrue(quiet.completedWithoutOutput)

        guard case .generic(let failed) = full(tool("deploy_preview", state: .error, result: "denied")).main else { return XCTFail("generic") }
        XCTAssertEqual(failed.error, "denied")
        XCTAssertNil(failed.output)
        XCTAssertFalse(failed.completedWithoutOutput)

        var titled = tool("deploy_preview")
        titled.title = "Deploy preview"
        guard case .generic(let named) = full(titled).main else { return XCTFail("generic") }
        XCTAssertEqual(named.description, "Deploy preview", "the display title stands in for a missing description")
    }

    func testEditsShowTheirDiffsThenHowTheyWent() {
        let edit = full(tool("Edit", ["file_path": "/repo/a.swift", "old_string": "a", "new_string": "b"], result: "Updated."))
        XCTAssertEqual(edit.main, .diff(.edit, chunks: [ToolDiffChunk(oldText: "a", newText: "b", fileName: "/repo/a.swift")], replaceAll: []))
        XCTAssertEqual(edit.outcome, .output("Updated."))
        XCTAssertTrue(edit.wide)

        let multi = full(tool("MultiEdit", ["file_path": "/repo/a.swift", "edits": [
            ["old_string": "a", "new_string": "b"],
            ["old_string": "c", "new_string": "d", "replace_all": .bool(true)],
        ]], state: .error, result: "String not found"))
        guard case .diff(.multiEdit, let chunks, let replaceAll) = multi.main else { return XCTFail("diff") }
        XCTAssertEqual(chunks.count, 2)
        XCTAssertEqual(replaceAll, [false, true])
        XCTAssertEqual(multi.outcome, .error(.text("String not found")))

        XCTAssertEqual(full(tool("write", ["file_path": "/repo/n.md", "content": "x"])).main,
                       .diff(.write, chunks: [ToolDiffChunk(oldText: "", newText: "x", fileName: "/repo/n.md")], replaceAll: []))
        XCTAssertFalse(full(tool("Task")).wide)
    }

    func testPatchesAndTurnDiffsHaveViewsOfTheirOwn() {
        let patch = full(tool("CodexPatch", ["changes": ["/repo/a.ts": ["kind": ["type": "add"], "diff": "x"]]], result: "Done"))
        XCTAssertEqual(patch.main, .patch([ToolPatchFile(file: "/repo/a.ts", path: "a.ts", movePath: nil, kind: .added, diff: .pair(old: "", new: "x"))]))
        XCTAssertEqual(patch.outcome, .output("Done"))
        XCTAssertEqual(full(tool("apply_patch", ["input": "*** Begin Patch"])).main, .patch(nil), "PatchFallback")
        XCTAssertEqual(full(tool("GeminiDiff", ["unified_diff": "@@ -1 +1 @@\n-a\n+b", "path": "x.py"])).main,
                       .unifiedDiff(ToolUnifiedDiff(["unified_diff": "@@ -1 +1 @@\n-a\n+b", "path": "x.py"])))
        XCTAssertEqual(full(tool("CodexDiff")).main, .unifiedDiff(nil))
    }

    func testATaskEndsWithHowItWent() {
        XCTAssertEqual(full(tool("Task", ["description": "Explore"], result: "Found it")).outcome, .output("Found it"))
        XCTAssertEqual(full(tool("Task", ["description": "Explore"], result: "")).outcome, .output(""), "an empty result is still an output")
        XCTAssertEqual(full(tool("Agent", state: .error)).outcome, .error(.unspecified))
        XCTAssertNil(full(tool("Task", state: .running)).outcome)
        XCTAssertEqual(full(tool("Task")).main, .task)
    }

    func testDevModeShowsTheCallAndItsSubAgentAsJSON() {
        var call = tool("Task", ["description": "Explore"], result: "Found it")
        call.callId = "toolu_1"
        call.permission = ToolPermission(id: "p1", status: .approved, mode: "default")
        let child = ToolCall(callId: "toolu_2", name: "Read", state: .running, input: ["file_path": "/repo/a"], createdAt: 5)
        let message = ToolCallMessage(id: "m1", createdAt: 1, tool: call, children: [
            .agentText(AgentTextMessage(id: "c1", createdAt: 2, text: "Looking")),
            .toolCall(ToolCallMessage(id: "c2", localId: "l2", createdAt: 3, tool: child)),
        ])
        let json = ToolFullPresentation.rawJSON(message)
        XCTAssertEqual(json["name"], "Task")
        XCTAssertEqual(json["state"], "completed")
        XCTAssertEqual(json["result"], "Found it")
        XCTAssertEqual(json["startedAt"], .null, "nullable fields are written as null")
        XCTAssertNil(json["title"], "absent optionals are left out")
        XCTAssertNil(json["callId"], "the screen lists the call's fields by name, without its id")
        XCTAssertEqual(json["permission"], ["id": "p1", "status": "approved", "mode": "default"])
        let messages = json["messages"]?.arrayValue ?? []
        XCTAssertEqual(messages.count, 2)
        XCTAssertEqual(messages.first, ["kind": "agent-text", "id": "c1", "localId": .null, "createdAt": 2, "text": "Looking"])
        XCTAssertEqual(messages.last?["tool"]?["callId"], "toolu_2", "a child's tool is the whole ToolCall")
        XCTAssertEqual(messages.last?["children"], .array([]))
        XCTAssertEqual(messages.last?["localId"], "l2")
    }
}

// Expected values follow EditView, WriteView, MultiEditView and
// GeminiEditView reading their inputs through knownTools' zod schemas.
final class ToolDiffInputsTests: XCTestCase {
    func testEditAndWrite() {
        XCTAssertEqual(ToolDiffInputs.chunks(.edit, input: ["file_path": "/r/a.swift", "old_string": "a", "new_string": "b"]),
                       [ToolDiffChunk(oldText: "a", newText: "b", fileName: "/r/a.swift")])
        XCTAssertEqual(ToolDiffInputs.chunks(.edit, input: ["old_string": "a", "new_string": "b"]),
                       [ToolDiffChunk(oldText: "", newText: "", fileName: nil)], "no file_path: the schema fails, so nothing to compare")
        XCTAssertEqual(ToolDiffInputs.chunks(.edit, input: ["file_path": "/r/a", "old_string": "a", "new_string": "b", "replace_all": .null]),
                       [ToolDiffChunk(oldText: "", newText: "", fileName: nil)], "replace_all must be a boolean when present")
        XCTAssertEqual(ToolDiffInputs.chunks(.write, input: ["file_path": "/r/new.md", "content": "# Hi"]),
                       [ToolDiffChunk(oldText: "", newText: "# Hi", fileName: "/r/new.md")])
        XCTAssertEqual(ToolDiffInputs.chunks(.write, input: ["file_path": "/r/new.md"]),
                       [ToolDiffChunk(oldText: "", newText: "<no contents>", fileName: nil)])
    }

    func testMultiEditHasOneDiffPerEdit() {
        let input: JSONValue = ["file_path": "/r/a.swift", "edits": [
            ["old_string": "a", "new_string": "b"],
            ["old_string": "c", "new_string": "d", "replace_all": .bool(true)],
        ]]
        XCTAssertEqual(ToolDiffInputs.chunks(.multiEdit, input: input), [
            ToolDiffChunk(oldText: "a", newText: "b", fileName: "/r/a.swift"),
            ToolDiffChunk(oldText: "c", newText: "d", fileName: "/r/a.swift"),
        ])
        XCTAssertEqual(ToolDiffInputs.chunks(.multiEdit, input: ["file_path": "/r/a", "edits": [["old_string": "a"]]]), [], "one bad edit fails the schema")
    }

    func testGeminiLooksInThreePlaces() {
        XCTAssertEqual(ToolDiffInputs.chunks(.geminiEdit, input: ["toolCall": ["content": [["oldText": "a", "newText": "b", "path": "/w/x.py"]]], "oldText": "ignored"]),
                       [ToolDiffChunk(oldText: "a", newText: "b", fileName: "/w/x.py")])
        XCTAssertEqual(ToolDiffInputs.chunks(.geminiEdit, input: ["input": [["newText": "b"]]]),
                       [ToolDiffChunk(oldText: "", newText: "b", fileName: nil)])
        XCTAssertEqual(ToolDiffInputs.chunks(.geminiEdit, input: ["old_string": "a", "newText": "b", "file_path": "/w/y.py"]),
                       [ToolDiffChunk(oldText: "a", newText: "b", fileName: "/w/y.py")])
        XCTAssertEqual(ToolDiffInputs.chunks(.bash, input: ["command": "ls"]), [])
    }
}

final class ToolFileInputTests: XCTestCase {
    func testTheAttachmentReadsLikeItsSchema() {
        let input = ToolFileInput(["ref": "r1", "name": "photo.png", "size": 1200, "image": ["width": 640, "height": 480, "thumbhash": "abc"]])
        XCTAssertEqual(input?.ref, "r1")
        XCTAssertEqual(input?.name, "photo.png")
        XCTAssertEqual(input?.imageWidth, 640)
        XCTAssertEqual(input?.imageHeight, 480)
        XCTAssertEqual(input?.thumbhash, "abc")
        XCTAssertNil(ToolFileInput(["ref": "r1", "name": "a.png"])?.imageWidth, "no size given")
        XCTAssertNil(ToolFileInput(["name": "a.png"]), "no ref")
        XCTAssertNil(ToolFileInput(["ref": "r1", "name": "a.png", "size": "big"]))
        XCTAssertNil(ToolFileInput(["ref": "r1", "name": "a.png", "image": ["width": 1]]), "an image without its height")
        XCTAssertNil(ToolFileInput(["ref": "r1", "name": "a.png", "image": .null]))
    }
}
