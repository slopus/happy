import Foundation
import XCTest
import HappyCore
import HappyWire

/// A Happy Agent tool call's screen, decided from its block: the daemon's
/// presentation first, then the raw data read by what the tool is, then
/// labelled fields.
final class ToolDetailTests: XCTestCase {
    private func block(_ json: String) throws -> AgentWire.Block {
        try JSONDecoder().decode(AgentWire.Block.self, from: Data(json.utf8))
    }

    private func tool(_ json: String) throws -> ChatItem.Tool {
        guard case .toolCall(let id, let name, let status, let presentation, let arguments, _, let result, let review) = try block(json) else {
            throw XCTSkip("not a tool call")
        }
        return ChatItem.Tool(name: name, status: status, presentation: presentation, callId: id, arguments: arguments, result: result, review: review)
    }

    // MARK: Wire

    func testAFileDiffKeepsItsHunksAndDropsTheRawData() throws {
        let call = try block("""
        {"type":"tool_call","id":"c1","name":"Edit","status":"completed",
         "arguments":{"file_path":"/w/a.ts","old_string":"a","new_string":"b"},"result":{"output":"ok"},
         "presentation":{"type":"file_diff","omittedFiles":2,"files":[{"path":"sources/a.ts","kind":"update","added":1,"deleted":1,"language":"typescript","omittedLines":3,
           "hunks":[{"oldStart":12,"newStart":12,"lines":[{"kind":"context","text":"x"},{"kind":"delete","text":"return a;"},{"kind":"add","text":"return b;"}]}]}]}}
        """)
        guard case .toolCall(_, _, _, let presentation?, let arguments, _, let result, _) = call else { return XCTFail() }
        XCTAssertNil(arguments)
        XCTAssertNil(result)
        XCTAssertEqual(presentation.omittedFiles, 2)
        let file = try XCTUnwrap(presentation.files?.first)
        XCTAssertEqual(file.language, "typescript")
        XCTAssertEqual(file.omittedLines, 3)
        XCTAssertEqual(file.hunks?.first?.lines.map(\.kind), ["context", "delete", "add"])
    }

    func testACallWithoutAPresentationKeepsItsRawDataBounded() throws {
        let long = String(repeating: "x", count: ToolRaw.maxString + 10)
        let call = try block("""
        {"type":"tool_call","id":"c1","name":"mcp__github__create_issue","status":"completed","arguments":{"title":"Bug"},"result":{"output":"\(long)"}}
        """)
        guard case .toolCall(_, _, _, nil, let arguments, _, let result, _) = call else { return XCTFail() }
        XCTAssertEqual(arguments, .object(["title": .string("Bug")]))
        XCTAssertEqual(result?["output"]?.stringValue?.count, ToolRaw.maxString + ToolRaw.cutMark.count)
        XCTAssertTrue(ToolRaw.isCut(result))
        XCTAssertFalse(ToolRaw.isCut(arguments))
    }

    func testAReviewTravelsWithItsElevationAndRoundTrips() throws {
        let call = try block("""
        {"type":"tool_call","id":"c1","name":"exec_command","status":"completed","elevated":true,
         "review":{"outcome":"allowed","reason":"Asked for it.","risk":"high","userAuthorization":"high"},
         "presentation":{"type":"exec_command","command":"pnpm test","output":"42 passed"}}
        """)
        guard case .toolCall(_, _, _, let presentation, _, _, _, let review?) = call else { return XCTFail() }
        XCTAssertEqual(review, AgentWire.ToolReview(outcome: "allowed", reason: "Asked for it.", risk: "high", userAuthorization: "high", elevated: true))
        XCTAssertEqual(presentation?.output, "42 passed")
        let again = try JSONDecoder().decode(AgentWire.Block.self, from: JSONEncoder().encode(call))
        XCTAssertEqual(again, call)
    }

    // MARK: Presentations

    func testATerminalShowsTheCommandAndItsOutput() throws {
        let detail = ToolDetail(try tool("""
        {"type":"tool_call","id":"c1","name":"Bash","status":"completed","presentation":{"type":"exec_command","command":"ls -la","output":"a\\nb"}}
        """))
        XCTAssertEqual(detail.kind, .terminal)
        XCTAssertEqual(detail.status, .completed)
        XCTAssertEqual(detail.sections, [.terminal(command: "ls -la", output: "a\nb", prompt: true)])
        XCTAssertFalse(detail.wantsFullData)
    }

    func testARunningCommandHasNoOutputYet() throws {
        let detail = ToolDetail(try tool("""
        {"type":"tool_call","id":"c1","name":"exec_command","status":"running","presentation":{"type":"exec_command","command":"sleep 5"}}
        """))
        XCTAssertEqual(detail.status, .running)
        XCTAssertEqual(detail.sections, [.terminal(command: "sleep 5", output: nil, prompt: true)])
    }

    func testAFileDiffBecomesAUnifiedPatch() throws {
        let detail = ToolDetail(try tool("""
        {"type":"tool_call","id":"c1","name":"apply_patch","status":"completed","presentation":{"type":"file_diff","files":[
          {"path":"a.ts","kind":"update","added":1,"deleted":1,"hunks":[{"oldStart":3,"newStart":3,"lines":[{"kind":"context","text":"x"},{"kind":"delete","text":"old"},{"kind":"add","text":"new"}]}]},
          {"path":"b.md","kind":"add","added":2,"deleted":0,"hunks":[{"oldStart":0,"newStart":1,"lines":[{"kind":"add","text":"# B"},{"kind":"add","text":""}]}]}]}}
        """))
        XCTAssertEqual(detail.kind, .fileEdit)
        guard case .files(let files, let omitted)? = detail.sections.first else { return XCTFail() }
        XCTAssertEqual(omitted, 0)
        XCTAssertEqual(files.map(\.path), ["a.ts", "b.md"])
        XCTAssertEqual(files[0].source, .patch("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -3,2 +3,2 @@\n x\n-old\n+new\n"))
        XCTAssertEqual(files[1].source, .patch("diff --git a/b.md b/b.md\nnew file mode 100644\n--- /dev/null\n+++ b/b.md\n@@ -0,0 +1,2 @@\n+# B\n+\n"))
    }

    func testTheDiffEngineReadsTheDaemonsHunksWithTheirLineNumbers() {
        let patch = FileDiffPatch.unified(path: "a.ts", kind: "update", hunks: [
            .init(oldStart: 12, newStart: 14, lines: [.init(kind: "context", text: "x"), .init(kind: "delete", text: "a"), .init(kind: "add", text: "b"), .init(kind: "add", text: "c")]),
        ])
        let document = DiffEngine.build(patch: patch)
        let file = try? XCTUnwrap(document.files.first)
        XCTAssertEqual(file?.path, "a.ts")
        XCTAssertEqual(file?.additions, 2)
        XCTAssertEqual(file?.deletions, 1)
        let lines = file?.rows.compactMap(\.line) ?? []
        XCTAssertEqual(lines.map(\.type), [.ctx, .del, .add, .add])
        XCTAssertEqual(lines.map(\.oldNo), [12, 13, nil, nil])
        XCTAssertEqual(lines.map(\.newNo), [14, nil, 15, 16])
    }

    func testAnExplorationListsItsReadsAndAsksForTheOutputHistoryLeftOut() throws {
        let detail = ToolDetail(try tool("""
        {"type":"tool_call","id":"c1","name":"Read","status":"completed","presentation":{"type":"exploration","operations":[{"kind":"read","name":"sources/login.ts"}]}}
        """))
        XCTAssertEqual(detail.kind, .exploration)
        XCTAssertEqual(detail.sections, [.operations([.init(kind: "read", subject: "sources/login.ts")])])
        XCTAssertTrue(detail.wantsFullData)
    }

    func testAReadShowsTheFileOnceItsResultIsRead() throws {
        let tool = try tool("""
        {"type":"tool_call","id":"c1","name":"Read","status":"completed","presentation":{"type":"exploration","operations":[{"kind":"read","name":"a.ts"}]}}
        """)
        let detail = ToolDetail(tool, full: (.object(["file_path": .string("/w/a.ts")]), .object(["output": .string("1\tlet a")])))
        XCTAssertEqual(detail.sections, [.operations([.init(kind: "read", subject: "a.ts")]), .code(.content, "1\tlet a", path: "a.ts")])
        XCTAssertFalse(detail.wantsFullData)
    }

    func testASearchNamesItsQueryAndSources() throws {
        let detail = ToolDetail(try tool("""
        {"type":"tool_call","id":"c1","name":"claude_web_search","status":"completed","presentation":{"type":"search","target":"web","query":"thumbhash","sources":[{"title":"Spec","url":"https://evanw.github.io/thumbhash/"}]}}
        """))
        XCTAssertEqual(detail.kind, .search)
        XCTAssertEqual(detail.sections, [
            .fields(nil, [.init("Query", .text("thumbhash")), .init("Searched", .text("Web"))]),
            .links([.init(title: "Spec", url: "https://evanw.github.io/thumbhash/")]),
        ])
    }

    func testAnUnknownPresentationFallsBackToTheRawData() throws {
        let detail = ToolDetail(try tool("""
        {"type":"tool_call","id":"c1","name":"future_tool","status":"completed","arguments":{"depth":2},"presentation":{"type":"hologram"}}
        """))
        XCTAssertEqual(detail.kind, .tool)
        XCTAssertEqual(detail.sections, [.fields(.arguments, [.init("Depth", .scalar("2"))])])
    }

    // MARK: Raw arguments

    func testAPlanIsAChecklist() throws {
        let detail = ToolDetail(try tool("""
        {"type":"tool_call","id":"c1","name":"update_plan","status":"completed","arguments":{"explanation":"Two steps.","plan":[{"step":"Read","status":"completed"},{"step":"Fix","status":"in_progress"},{"step":"Ship","status":"pending"}]}}
        """))
        XCTAssertEqual(detail.kind, .plan)
        XCTAssertEqual(detail.sections, [
            .text(.explanation, "Two steps."),
            .checklist(.plan, [.init("Read", .done), .init("Fix", .active), .init("Ship", .pending)]),
        ])
    }

    func testGroksTodosAreAChecklistToo() throws {
        let detail = ToolDetail(try tool("""
        {"type":"tool_call","id":"c1","name":"todo_write","status":"completed","arguments":{"merge":false,"todos":[{"id":"1","content":"Read","status":"completed"},{"id":"2","content":"Fix","status":"cancelled"}]}}
        """))
        XCTAssertEqual(detail.sections, [
            .checklist(.plan, [.init("Read", .done), .init("Fix", .cancelled)]),
            .fields(nil, [.init("Merge", .scalar("false"))]),
        ])
    }

    func testASubagentShowsItsTaskModelAndPrompt() throws {
        let detail = ToolDetail(try tool("""
        {"type":"tool_call","id":"c1","name":"spawn_agent","status":"completed","arguments":{"task_name":"audit","message":"Audit the login flow.","model":"gpt-5.6"},"result":{"output":"Spawned."}}
        """))
        XCTAssertEqual(detail.kind, .subagent)
        XCTAssertEqual(detail.sections, [
            .fields(nil, [.init("Task", .text("audit")), .init("Model", .mono("gpt-5.6"))]),
            .text(.prompt, "Audit the login flow."),
            .code(.result, "Spawned.", path: nil),
        ])
    }

    func testAnAgentSpawnPresentationAddsTheModelName() throws {
        let detail = ToolDetail(try tool("""
        {"type":"tool_call","id":"c1","name":"create_agent","status":"completed","arguments":{"title":"Research","message":"Look into it."},
         "presentation":{"type":"agent_spawn","model":{"modelId":"xai/grok-4.6","providerId":"grok","name":"Grok 4.6"}}}
        """))
        XCTAssertEqual(detail.kind, .subagent)
        XCTAssertEqual(detail.sections, [
            .fields(nil, [.init("Model", .text("Grok 4.6"))]),
            .fields(nil, [.init("Task", .text("Research"))]),
            .text(.prompt, "Look into it."),
        ])
    }

    func testAWebFetchLinksItsURL() throws {
        let detail = ToolDetail(try tool("""
        {"type":"tool_call","id":"c1","name":"WebFetch","status":"completed","arguments":{"url":"https://example.com","prompt":"Summarize"},"result":{"output":"Example."}}
        """))
        XCTAssertEqual(detail.kind, .web)
        XCTAssertEqual(detail.sections, [
            .fields(nil, [.init("URL", .link("https://example.com"))]),
            .text(.prompt, "Summarize"),
            .code(.result, "Example.", path: nil),
        ])
    }

    func testAnEditStillRunningShowsBothSides() throws {
        let detail = ToolDetail(try tool("""
        {"type":"tool_call","id":"c1","name":"search_replace","status":"running","arguments":{"file_path":"a.swift","old_string":"a","new_string":"b"}}
        """))
        XCTAssertEqual(detail.sections, [.files([.init(path: "a.swift", kind: "update", added: 0, deleted: 0, source: .pair(old: "a", new: "b"))], omittedFiles: 0)])
    }

    func testAnyOtherToolShowsItsArgumentsAsFieldsAndItsJSONResultAsFields() throws {
        let detail = ToolDetail(try tool("""
        {"type":"tool_call","id":"c1","name":"mcp__github__create_issue","status":"completed",
         "arguments":{"title":"Crash","body":"Line one\\nLine two","labels":["bug","ios"],"repo":{"owner":"slopus","name":"happy"}},
         "result":{"output":"{\\"number\\":42,\\"url\\":\\"https://github.com/slopus/happy/issues/42\\"}"}}
        """))
        XCTAssertEqual(detail.toolName, "github · create issue")
        XCTAssertEqual(detail.kind, .tool)
        XCTAssertEqual(detail.sections, [
            .fields(.arguments, [
                .init("Title", .text("Crash")),
                .init("Body", .block("Line one\nLine two")),
                .init("Labels", .list([.text("bug"), .text("ios")])),
                .init("Repo", .fields([.init("Name", .mono("happy")), .init("Owner", .text("slopus"))])),
            ]),
            .fields(.result, [.init("URL", .link("https://github.com/slopus/happy/issues/42")), .init("Number", .scalar("42"))]),
        ])
    }

    func testMCPTextContentReadsAsText() {
        XCTAssertEqual(ToolDetail.resultBody(.object(["content": .array([.object(["type": .string("text"), "text": .string("Done")])])])), .text("Done"))
        XCTAssertEqual(ToolDetail.resultBody(.object(["output": .string("[{\"type\":\"text\",\"text\":\"Hi\"}]")])), .text("Hi"))
        XCTAssertNil(ToolDetail.resultBody(.object(["output": .string("  ")])))
    }

    func testValuesNestedPastTwoLevelsAreJSON() {
        let deep: JSONValue = .object(["a": .object(["b": .object(["c": .number(1)])])])
        XCTAssertEqual(ToolDetail.value(deep), .fields([.init("A", .fields([.init("B", .json("{\n  \"c\" : 1\n}"))]))]))
    }

    func testAFailedCallShowsItsError() throws {
        let detail = ToolDetail(try tool("""
        {"type":"tool_call","id":"c1","name":"read_skill","status":"failed","arguments":{"name":"nope"},"result":{"output":"Skill not found."}}
        """))
        XCTAssertEqual(detail.status, .failed)
        XCTAssertEqual(detail.sections, [.fields(.arguments, [.init("Name", .mono("nope"))]), .error("Skill not found.")])
    }

    func testAReviewEndsTheScreen() throws {
        let detail = ToolDetail(try tool("""
        {"type":"tool_call","id":"c1","name":"exec_command","status":"failed","elevated":false,"review":{"outcome":"denied","reason":"Deletes the home folder.","risk":"critical","userAuthorization":"low"},
         "presentation":{"type":"exec_command","command":"rm -rf ~"}}
        """))
        XCTAssertEqual(detail.sections.last, .review(AgentWire.ToolReview(outcome: "denied", reason: "Deletes the home folder.", risk: "critical", userAuthorization: "low", elevated: false)))
    }

    func testNamesReadAsDesktopHumanizesThem() {
        XCTAssertEqual(ToolDetail.humanize("run_terminal_command"), "Run terminal command")
        XCTAssertEqual(ToolDetail.humanize("WebFetch"), "Web Fetch")
        XCTAssertEqual(ToolDetail.label("file_path"), "File")
        XCTAssertEqual(ToolDetail.label("allowed_domains"), "Allowed domains")
    }
}

/// A workspace's git state as the agent API sends it, which leaves out
/// what the session RPC sends as null.
final class WorkspaceChangesTests: XCTestCase {
    func testADetachedHeadsStateReads() throws {
        let raw: JSONValue = .object([
            "facts": .object(["detached": .bool(true), "head": .string("9c2f1e7"), "ahead": .number(0), "behind": .number(0)]),
            "comparison": .string("ready"), "base": .string("9c2f1e7a00000000000000000000000000000000"),
            "changedFiles": .number(1), "insertions": .number(3), "deletions": .number(1), "countsExact": .bool(true), "conflicted": .bool(false),
            "files": .array([.object(["path": .string("a.ts"), "status": .string("modified"), "staged": .bool(false), "unstaged": .bool(true), "binary": .bool(false), "insertions": .number(3), "deletions": .number(1)])]),
            "filesTruncated": .bool(false), "scannedAt": .number(1),
        ])
        XCTAssertThrowsError(try HappyAgentGitState(raw))
        let state = try HappyAgentGitState(WorkspaceChanges.normalized(raw))
        XCTAssertEqual(state.files.map(\.path), ["a.ts"])
        XCTAssertNil(state.facts.branch)
        XCTAssertEqual(HappyAgentChanges.base(state), "9c2f1e7a00000000000000000000000000000000")
    }

    func testACommitishBaseIsKept() throws {
        let raw: JSONValue = .object([
            "facts": .object(["branch": .string("main"), "detached": .bool(false), "ahead": .number(2), "behind": .number(0)]),
            "comparison": .string("ready"), "base": .string("origin/main"),
            "changedFiles": .number(0), "insertions": .number(0), "deletions": .number(0), "countsExact": .bool(true), "conflicted": .bool(false),
            "files": .array([]), "filesTruncated": .bool(false), "scannedAt": .number(1),
        ])
        XCTAssertThrowsError(try HappyAgentGitState(WorkspaceChanges.normalized(raw)))
        let state = try HappyAgentGitState(WorkspaceChanges.normalized(raw), base: WorkspaceChanges.commitish)
        XCTAssertEqual(HappyAgentChanges.base(state), "origin/main")
        XCTAssertTrue(HappyAgentChanges.isClean(state))
    }
}
