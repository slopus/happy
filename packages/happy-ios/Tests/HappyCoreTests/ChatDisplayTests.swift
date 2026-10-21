import XCTest
import HappyWire
@testable import HappyCore

// Expected values come from running happy-app's own toolDisplay.ts,
// useGroupedMessages.ts, agentTurns.ts and codexPatchEntry.ts under node on
// the same inputs.

// Literals keep the tool inputs below readable.
extension JSONValue: ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral,
    ExpressibleByStringLiteral, ExpressibleByIntegerLiteral {
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
    }

    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
}

private let words = ToolActionWords(ran: "Ran", edited: "Edited", read: "Read", searched: "Searched", fetched: "Fetched", ranTask: "Ran task")

private func tool(_ name: String, _ input: JSONValue = .object([:]), title: String? = nil, description: String? = nil, permission: ToolPermission.Status? = nil) -> ToolCall {
    ToolCall(
        name: name, title: title, state: .completed, input: input, createdAt: 0, description: description,
        permission: permission.map { ToolPermission(id: "perm", status: $0) }
    )
}

private func user(_ id: String, pending: Bool = false, sendError: String? = nil) -> ChatMessage {
    .userText(UserTextMessage(id: id, createdAt: 0, text: id, pending: pending, sendError: sendError))
}

private func agent(_ id: String, _ at: Int64, turn: String? = nil, text: String? = nil, thinking: Bool = false) -> ChatMessage {
    .agentText(AgentTextMessage(id: id, createdAt: at, turn: turn, text: text ?? id, isThinking: thinking))
}

private func call(_ id: String, _ name: String, _ at: Int64, turn: String? = nil, permission: ToolPermission.Status? = nil) -> ChatMessage {
    .toolCall(ToolCallMessage(id: id, createdAt: at, turn: turn, tool: tool(name, permission: permission)))
}

final class ChatToolDisplayTests: XCTestCase {
    let tools: [ToolCall] = [
        tool("Bash", ["command": "ls -la", "description": "List files"], description: "List files"),
        tool("CodexBash", ["command": ["bash", "-lc", "git status"]]),
        tool("Read", ["file_path": "/a/b.swift"]),
        tool("Grep", ["pattern": "TODO"]),
        tool("mcp__linear__create_issue", ["title": "Bug"]),
        tool("WebFetch", ["url": "https://x.io"], description: "Fetch URL"),
        tool("Task", ["description": "Explore"], description: "Explore the code"),
        tool("BashOutput", ["bash_id": "b1"]),
        tool("some_newTool"),
        tool("apply_patch", [
            "input": "*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n*** Add File: b.txt\n+hi\n*** End Patch",
            "workdir": "/w",
        ]),
        tool("custom", ["path": "src"], title: "Custom"),
        tool("Edit", ["file_path": "x"], description: "Edit file"),
        tool("create_agent"),
        tool("readAgent_history-now"),
        tool("write_stdin", ["session_id": 7, "chars": ""]),
        tool("Agent", ["prompt": "p"], description: "Running Agent"),
        tool("CodexPatch", ["changes": ["z.txt": ["kind": ["type": "add"]], "a.txt": ["diff": "@@ -1 +1 @@"]]]),
        tool("execute", ["toolCall": ["title": "npm test [cwd]"]]),
    ]

    func testActivityLabels() {
        XCTAssertEqual(tools.map { ChatToolDisplay.activityLabel($0, words: words) }, [
            "ls -la", "git status", "Read: /a/b.swift", "Searched: TODO", "MCP: Linear Create Issue: Bug",
            "Fetched: https://x.io", "Explore the code", "Reading shell output (b1)", "Some New Tool",
            "Edited: /w/a.txt +1", "Custom: src", "Edited: x", "Start collaborator", "Read Agent History Now",
            "Waiting for shell output (7)", "Ran task",
            // happy-app says "z.txt +1": a JS object keeps key order, a
            // decoded JSONValue doesn't, so files come sorted.
            "Edited: a.txt +1",
            "npm test",
        ])
    }

    func testSummaryDetails() {
        XCTAssertEqual(tools.map(ChatToolDisplay.summaryDetail), [
            "ls -la", "git status", "/a/b.swift", "TODO", "Bug", "https://x.io", "Explore the code", nil, nil,
            "/w/a.txt +1", "src", "x", nil, nil, nil, "Running Agent", "a.txt +1", "npm test",
        ])
    }

    func testDisplayTitles() {
        XCTAssertEqual(tools.map { ChatToolDisplay.displayTitle($0, words: words) }, [
            "Ran", "Ran", "Read", "Searched", "MCP: Linear Create Issue", "Fetched", "Ran task", "Read shell output",
            "Some New Tool", "Edited", "Custom", "Edited", "Start collaborator", "Read Agent History Now",
            "Shell session", "Ran task", "Edited", "Ran",
        ])
        XCTAssertEqual(ChatToolDisplay.mcpTitle("mcp__my_server__do_THING"), "MCP: My Server Do Thing")
    }

    func testCompactRowDecision() {
        XCTAssertEqual([
            ChatToolDisplay.usesCompactRow(tool("Bash"), compactMode: false, hasInlineView: true),
            ChatToolDisplay.usesCompactRow(tool("weird"), compactMode: false, hasInlineView: false),
            ChatToolDisplay.usesCompactRow(tool("weird", permission: .pending), compactMode: false, hasInlineView: false),
            ChatToolDisplay.usesCompactRow(tool("ExitPlanMode", permission: .pending), compactMode: true, hasInlineView: true),
            ChatToolDisplay.usesCompactRow(tool("ExitPlanMode", permission: .approved), compactMode: true, hasInlineView: true),
            ChatToolDisplay.usesCompactRow(tool("file"), compactMode: true, hasInlineView: true),
            ChatToolDisplay.usesCompactRow(tool("AskUserQuestion"), compactMode: true, hasInlineView: false),
            ChatToolDisplay.usesCompactRow(tool("Edit"), compactMode: true, hasInlineView: true),
        ], [false, true, false, false, true, false, false, true])
    }

    func testHiddenAndCategories() {
        XCTAssertTrue(ChatToolDisplay.isHidden("ToolSearch"))
        XCTAssertFalse(ChatToolDisplay.isHidden("Bash"))
        XCTAssertEqual(ChatToolDisplay.category("BashStop"), .terminal)
        XCTAssertEqual(ChatToolDisplay.category("list_tasks"), .search)
        XCTAssertEqual(ChatToolDisplay.category("Glob"), .search)
        XCTAssertEqual(ChatToolDisplay.category("nope"), .other)
        XCTAssertFalse(ChatToolDisplay.rendersCardHeader("apply_patch"))
        XCTAssertTrue(ChatToolDisplay.rendersCardHeader("Edit"))
    }
}

final class ChatDisplayTests: XCTestCase {
    // Newest first, as happy-app holds them.
    let messages: [ChatMessage] = [
        user("p1", pending: true),
        agent("a5", 50, turn: "t2"),
        call("c4", "Bash", 40, turn: "t2"),
        agent("th", 35, turn: "t2", thinking: true),
        call("c3", "Read", 30, turn: "t2"),
        user("u2"),
        agent("a2", 20),
        call("c1", "Edit", 15, permission: .pending),
        call("cq", "AskUserQuestion", 12),
        call("c0", "ToolSearch", 10),
        agent("blank", 9, text: "  "),
        call("cf", "file", 8),
        user("u1"),
        agent("a0", 5, turn: "x"),
        call("cx", "Bash", 4, turn: "y"),
        agent("ay", 3, turn: "y"),
        user("u0", sendError: "nope"),
    ]

    func show(_ items: [ChatDisplayItem]) -> [String] {
        items.map { item in
            switch item {
            case .message(let message):
                return message.id
            case .workGroup(let group):
                let members = group.messages.map(\.id).joined(separator: ",")
                return "[\(group.id)|\(group.turnUserMessageId ?? "null")|\(members)|\(group.hasPendingPermission)|\(group.startedAt)|\(group.completedAt.map(String.init) ?? "null")]"
            }
        }
    }

    func testTurns() {
        XCTAssertEqual(ChatDisplay.assignTurns(messages), [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 2, 3, 3, 3])
    }

    func testGroupsFinishedTurns() {
        XCTAssertEqual(show(ChatDisplay.group(messages, enabled: true, collapseCurrentTurn: true)), [
            "u0", "ay", "cx", "a0", "u1", "cf", "cq", "[work-a2|u1|c1|true|15|20]", "a2", "u2",
            "[work-a5|u2|c3,c4|false|30|50]", "a5", "p1",
        ])
    }

    func testLeavesTheRunningTurnFlat() {
        XCTAssertEqual(show(ChatDisplay.group(messages, enabled: true, collapseCurrentTurn: false)), [
            "u0", "ay", "cx", "a0", "u1", "cf", "cq", "[work-a2|u1|c1|true|15|20]", "a2", "u2", "c3", "c4", "a5", "p1",
        ])
    }

    func testGroupingOffOnlyDropsInvisibleRows() {
        XCTAssertEqual(show(ChatDisplay.group(messages, enabled: false)), [
            "u0", "ay", "cx", "a0", "u1", "cf", "cq", "c1", "a2", "u2", "c3", "c4", "a5", "p1",
        ])
    }

    func testListItemsAreNewestFirstWithBothHeaders() {
        let items = ChatDisplay.group(messages, enabled: true)
        let folded = ChatDisplay.listItems(items) { _ in false }
        XCTAssertEqual(folded.map(\.id), ["p1", "a5", "work-a5", "u2", "a2", "work-a2", "cq", "cf", "u1", "a0", "cx", "ay", "u0"])
        let open = ChatDisplay.listItems(items) { $0.id == "work-a5" }
        XCTAssertEqual(open.prefix(6).map(\.id), ["p1", "a5", "work-a5:collapse", "c4", "c3", "work-a5"])
    }

    func testWindowEndsAtASettledPrompt() {
        XCTAssertEqual(ChatDisplay.windowEnd(messages, desiredEnd: 2), 6)
        XCTAssertEqual(ChatDisplay.windowEnd(messages, desiredEnd: 6), 6)
        // u0 failed, so it never closes a turn; the window runs to the end.
        XCTAssertEqual(ChatDisplay.windowEnd(messages, desiredEnd: 14), 17)
        XCTAssertEqual(ChatDisplay.windowEnd(messages, desiredEnd: 100), 17)
        XCTAssertEqual(ChatDisplay.windowEnd([], desiredEnd: 60), 0)
    }

    func testWorkDuration() {
        XCTAssertEqual([0, 999, 59_000, 61_000, 3_599_000, 3_600_000, 7_322_000].map { ChatDisplay.formatWorkDuration(milliseconds: $0) },
                       ["0s", "0s", "59s", "1m1s", "59m59s", "1h0m", "2h2m"])
    }

    func testGroupStateOpensWatchedAndPendingGroups() {
        let items = ChatDisplay.group(messages, enabled: true)
        guard case .workGroup(let pendingGroup) = items[7], case .workGroup(let doneGroup) = items[10] else {
            return XCTFail("expected groups")
        }
        var state = ChatWorkGroupState()
        XCTAssertTrue(state.isExpanded(pendingGroup, inForeground: true), "a pending permission opens its group")
        XCTAssertFalse(state.isExpanded(doneGroup, inForeground: true))

        // Watching u2's turn run keeps its work open once it finishes.
        XCTAssertTrue(state.watch(messages, currentTurnComplete: false, inForeground: true))
        XCTAssertEqual(state.watchedTurns, ["u2"])
        XCTAssertFalse(state.watch(messages, currentTurnComplete: true, inForeground: true))
        XCTAssertTrue(state.isExpanded(doneGroup, inForeground: true))
        XCTAssertFalse(state.isExpanded(doneGroup, inForeground: false))

        state.toggle(doneGroup, inForeground: true)
        XCTAssertFalse(state.isExpanded(doneGroup, inForeground: true), "closing beats watching")
        state.toggle(pendingGroup, inForeground: true)
        XCTAssertFalse(state.isExpanded(pendingGroup, inForeground: true), "closing beats a pending permission")
        state.toggle(pendingGroup, inForeground: true)
        XCTAssertTrue(state.isExpanded(pendingGroup, inForeground: true))

        state.enterBackground(items)
        XCTAssertEqual(state, ChatWorkGroupState())
    }
}

final class ChatPatchTests: XCTestCase {
    func testEnvelopeWithMoveAndDelete() throws {
        let changes = try XCTUnwrap(ChatPatch.parseEnvelope(
            "*** Begin Patch\n*** Update File: m.ts\n*** Move to: n.ts\n@@ fn()\n ctx\n-old\n+new\n*** End of File\n*** Delete File: gone.ts\n*** End Patch\n\n"
        ))
        XCTAssertEqual(changes.map(\.path), ["m.ts", "gone.ts"])
        XCTAssertEqual(changes[0].entry.kindLabel, "move")
        XCTAssertEqual(changes[0].entry.input, .pair(old: "fn()\nctx\nold", new: "fn()\nctx\nnew"))
        XCTAssertEqual(changes[1].entry.kindLabel, "delete")
        XCTAssertNil(changes[1].entry.input)
    }

    func testMalformedEnvelopes() {
        XCTAssertNil(ChatPatch.parseEnvelope("*** Begin Patch\n*** Add File: a\nnoplus\n*** End Patch"))
        XCTAssertNil(ChatPatch.parseEnvelope("*** Begin Patch\n*** Add File: a\n+1\n*** Add File: a\n+2\n*** End Patch"))
    }

    func testWorkdirAndLists() throws {
        let joined = try XCTUnwrap(ChatPatch.changes(["patch": "*** Begin Patch\n*** Add File: ../x/./y.txt\n+1\n*** End Patch", "workdir": "/w/sub"]))
        XCTAssertEqual(joined.map(\.path), ["/w/x/y.txt"])
        XCTAssertEqual(joined[0].entry.input, .pair(old: "", new: "1"))

        let list = try XCTUnwrap(ChatPatch.changes(["changes": [
            ["path": "q", "type": "add", "content": "c"],
            ["nope": 1],
            ["path": "r", "kind": ["type": "update", "move_path": "s"], "unified_diff": "x"],
        ]]))
        XCTAssertEqual(list.map(\.path), ["q", "r"])
        XCTAssertEqual(list[0].entry.input, .pair(old: "", new: "c"))
        XCTAssertEqual(list[1].entry.kindLabel, "move")
        XCTAssertEqual(list[1].entry.input, .pair(old: "", new: "x"))
    }

    func testUnifiedDiffSniffing() {
        XCTAssertEqual(["@@ -1 +1 @@", "a\n@@@ -1", "--- a", "hello @@ -1"].map(ChatPatch.looksLikeUnifiedDiff), [true, true, true, false])
    }

    func testThePatchViewsFiles() throws {
        let files = try XCTUnwrap(ChatPatch.viewFiles(["changes": [
            "/repo/src/a.ts": ["kind": ["type": "update"], "unified_diff": "@@ -1 +1 @@\n-x\n+y"],
            "/repo/b.ts": ["kind": ["type": "add"], "diff": "hello"],
            "/repo/c.ts": ["kind": ["type": "update", "move_path": "/repo/d.ts"], "modify": ["old_content": "", "new_content": ""]],
            "/elsewhere/e.ts": ["type": "delete", "unified_diff": "@@ -1 +0,0 @@\n-gone"],
        ]], root: "/repo"))
        XCTAssertEqual(files.map(\.path), ["/elsewhere/e.ts", "b.ts", "c.ts", "src/a.ts"])
        XCTAssertEqual(files.map(\.kind), [.deleted, .added, .renamed, .modified])
        // A hunk-only diff gains headers for the file, /dev/null on the side
        // a delete lacks.
        XCTAssertEqual(files[0].diff, .patch("--- a//elsewhere/e.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone"))
        XCTAssertEqual(files[1].diff, .pair(old: "", new: "hello"), "an add's diff is the file's body")
        XCTAssertNil(files[2].diff, "nothing on either side")
        XCTAssertEqual(files[2].movePath, "d.ts")
        XCTAssertEqual(files[3].diff, .patch("--- a//repo/src/a.ts\n+++ b//repo/src/a.ts\n@@ -1 +1 @@\n-x\n+y"))
        XCTAssertEqual(files[3].fileName, "a.ts")
        XCTAssertEqual(files[3].file, "/repo/src/a.ts")
        XCTAssertEqual(files.map(\.stats), [.init(additions: 0, deletions: 1), .init(additions: 1, deletions: 0), .init(additions: 0, deletions: 0), .init(additions: 1, deletions: 1)])

        XCTAssertNil(ChatPatch.viewFiles(["patch": "not an envelope"], root: nil))
        XCTAssertEqual(ChatPatch.fallbackText(["patch": "not an envelope"]), "not an envelope")
        XCTAssertEqual(ChatPatch.fallbackText(["input": "raw"]), "raw")
        XCTAssertEqual(ChatPatch.fallbackText(["changes": [:]]), "{\n  \"changes\": {}\n}")
    }

    func testTheTurnDiffNamesItsFile() {
        let diff = "--- a/x.swift\n+++ b/x.swift\n@@ -1 +1 @@\n-a\n+b"
        XCTAssertEqual(ToolUnifiedDiff(["unified_diff": .string(diff)])?.fileName, "x.swift")
        XCTAssertEqual(ToolUnifiedDiff(["unified_diff": .string(diff), "path": "/w/y.swift"])?.fileName, "/w/y.swift")
        XCTAssertNil(ToolUnifiedDiff(["unified_diff": "@@ -1 +1 @@\n-a\n+b"])?.fileName)
        XCTAssertNil(ToolUnifiedDiff(["unified_diff": ""]))
        XCTAssertNil(ToolUnifiedDiff([:]))
    }
}

final class LocalCommandMessageTests: XCTestCase {
    func testWrappersAndRawCommands() {
        let cases = [
            "<local-command-caveat>Caveat: x\ny</local-command-caveat>\n",
            "<local-command-stdout>Goal set: ship it </local-command-stdout>",
            "<local-command-stdout> hello </local-command-stdout>",
            "/goal finish the port",
            "/review",
            "/superpowers:brainstorm  do the thing \n",
            "please run /deploy now",
            "a/b is not a command",
            "<command-message>foo</command-message><command-name>/foo</command-name>",
            "<command-message>foo</command-message><command-name>/foo</command-name><command-args> the args </command-args>",
            "<command-name>/goal</command-name><command-args>win</command-args>",
            "before <command-name>/x</command-name> after",
            "plain **text**",
        ]
        XCTAssertEqual(cases.map(LocalCommandMessage.init), [
            .caveat,
            .goalConfirmation(goal: "ship it"),
            .text("hello"),
            .goalRun(goal: "finish the port"),
            .commandRun(name: "review", arguments: nil),
            .commandRun(name: "superpowers:brainstorm", arguments: "do the thing"),
            .commandRun(name: "deploy", arguments: "please run now"),
            .text("a/b is not a command"),
            .commandRun(name: "foo", arguments: nil),
            .commandRun(name: "foo", arguments: "the args"),
            .goalRun(goal: "win"),
            .text("before  after"),
            .text("plain **text**"),
        ])
    }

    func testSlashCommandEcho() {
        XCTAssertEqual([
            LocalCommandMessage.isSlashCommandEcho("/review", hasLocalId: true),
            LocalCommandMessage.isSlashCommandEcho("/review", hasLocalId: false),
            LocalCommandMessage.isSlashCommandEcho("hi", hasLocalId: true),
            LocalCommandMessage.isSlashCommandEcho("run /x now", hasLocalId: true),
        ], [true, false, false, true])
    }
}

// UserMessageFrame and usePendingStatusVisible in MessageView.tsx.
final class UserMessageStatusTests: XCTestCase {
    private func status(pending: Bool = true, undelivered: Bool = false, busy: Bool = false, age: Int64, failure: String? = nil) -> UserMessageStatus {
        UserMessageStatus(pending: pending, undelivered: undelivered, queuedWhileBusy: busy, createdAt: 10_000, failure: failure, now: 10_000 + age)
    }

    func testAWaitingMessageStaysQuietForTwoSeconds() {
        XCTAssertEqual(status(age: 1_999), UserMessageStatus(line: .none, dimmed: false))
        XCTAssertEqual(status(age: 2_000), UserMessageStatus(line: .sending, dimmed: true))
        XCTAssertEqual(UserMessageStatus.graceEnds(pending: true, undelivered: false, queuedWhileBusy: false, createdAt: 10_000, now: 10_500), 12_000)
        XCTAssertNil(UserMessageStatus.graceEnds(pending: true, undelivered: false, queuedWhileBusy: false, createdAt: 10_000, now: 12_000), "already shown")
    }

    func testAMessageQueuedBehindABusyTurnSaysSoAtOnce() {
        XCTAssertEqual(status(busy: true, age: 0), UserMessageStatus(line: .sendsAfterThisTurn, dimmed: true))
        XCTAssertNil(UserMessageStatus.graceEnds(pending: true, undelivered: false, queuedWhileBusy: true, createdAt: 10_000, now: 10_000))
    }

    func testOnlyAMessageTheAgentHasntReadIsDimmed() {
        XCTAssertEqual(status(pending: false, undelivered: true, age: 3_000), UserMessageStatus(line: .sending, dimmed: false), "still in the outbox")
        XCTAssertEqual(status(age: 0, failure: "refused"), UserMessageStatus(line: .failed("refused"), dimmed: false), "a refusal shows at once")
        XCTAssertEqual(status(pending: false, age: 5_000), UserMessageStatus(line: .none, dimmed: false))
        XCTAssertNil(UserMessageStatus.graceEnds(pending: false, undelivered: false, queuedWhileBusy: false, createdAt: 10_000, now: 10_000))
    }
}
