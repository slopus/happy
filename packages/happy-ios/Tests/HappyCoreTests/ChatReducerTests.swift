import XCTest
import HappyWire
@testable import HappyCore

/// reducer.spec.ts cases expressed in the current session and ACP formats.
final class ChatReducerTests: XCTestCase {
    func testProcessesUserMessagesWithLocalId() throws {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.user("s", localId: "l")])
        XCTAssertEqual(try ChatRecords.userRow(state.messages).localId, "l")
    }

    func testDoesNotDuplicateUserOrAgentMessagesWhenAppliedMultipleTimes() {
        var state = ChatReducer()
        let records = [ChatRecords.user("u"), ChatRecords.text("a"), ChatRecords.call("t")]
        _ = state.reduce(records)
        XCTAssertTrue(state.reduce(records).messages.isEmpty)
        XCTAssertEqual(state.messages.count, 3)
    }

    func testProcessesMultipleTextBlocksInOneAgentMessage() {
        var state = ChatReducer()
        var record = ChatRecords.text("a")
        record.body = .agent([
            .text("one", thinking: false), .text("two", thinking: false), .text("hmm", thinking: true),
        ])
        _ = state.reduce([record])
        XCTAssertEqual(state.messages.count, 3)
        if case .agentText(let row) = state.messages[2] {
            XCTAssertTrue(row.isThinking)
            XCTAssertEqual(row.text, "*hmm*")
        } else {
            XCTFail("thinking")
        }
    }

    func testHandlesInterleavedUserAndAgentMessages() {
        var state = ChatReducer()
        _ = state.reduce([
            ChatRecords.text("a2", at: 400), ChatRecords.user("u1", at: 100), ChatRecords.text("a1", at: 200),
            ChatRecords.user("u2", at: 300),
        ])
        XCTAssertEqual(state.messages.map(\.id), ["u1", "a1:0", "u2", "a2:0"])
    }

    func testHandlesEmptyMessageArrayAndNullAgentState() {
        var state = ChatReducer()
        XCTAssertTrue(state.reduce([], agentState: .null).messages.isEmpty)
    }

    func testCreatesToolMessagesForPendingPermissionRequests() throws {
        var state = ChatReducer()
        _ = state.reduce([], agentState: ChatRecords.permissionState())
        let row = try ChatRecords.toolRow(state.messages)
        XCTAssertEqual(row.tool.permission?.status, .pending)
        XCTAssertEqual(row.tool.state, .running)
        XCTAssertNil(row.tool.startedAt)
    }

    func testUpdatesPermissionStatusForCompletedRequests() throws {
        var state = ChatReducer()
        _ = state.reduce([], agentState: ChatRecords.permissionState())
        _ = state.reduce([], agentState: ChatRecords.permissionState(status: "approved"))
        let row = try ChatRecords.toolRow(state.messages)
        XCTAssertEqual(row.tool.permission?.status, .approved)
        XCTAssertEqual(state.messages.count, 1)
    }

    func testMatchesIncomingToolCallsToApprovedPermissionMessages() throws {
        var state = ChatReducer()
        _ = state.reduce([], agentState: ChatRecords.permissionState(status: "approved"))
        let before = try ChatRecords.toolRow(state.messages)
        _ = state.reduce([ChatRecords.call("start")])
        let after = try ChatRecords.toolRow(state.messages)
        XCTAssertEqual(before.id, after.id)
        XCTAssertEqual(after.tool.state, .running)
        XCTAssertNil(after.tool.result)
        XCTAssertNil(after.tool.completedAt)
    }

    func testMergesRealToolCallPatchArgsIntoMatchedPermissionMessages() throws {
        var state = ChatReducer()
        _ = state.reduce(
            [],
            agentState: ChatRecords.permissionState(
                arguments: ChatRecords.json(#"{"path":"/a","old":"old"}"#)))
        _ = state.reduce([ChatRecords.call("start", input: ChatRecords.json(#"{"path":"/b","new":"new"}"#))])
        XCTAssertEqual(
            try ChatRecords.toolRow(state.messages).tool.input,
            ChatRecords.json(#"{"path":"/b","old":"old","new":"new"}"#))
    }

    func testMatchesToolCallsByIdRegardlessOfArguments() throws {
        var state = ChatReducer()
        _ = state.reduce([], agentState: ChatRecords.permissionState(arguments: .string("before")))
        _ = state.reduce([ChatRecords.call("start", input: .object(["after": .bool(true)]))])
        XCTAssertEqual(state.messages.count, 1)
        XCTAssertEqual(try ChatRecords.toolRow(state.messages).tool.input, .object(["after": .bool(true)]))
    }

    func testDoesNotCreateDuplicateMessagesWhenCalledTwiceWithSameAgentState() {
        var state = ChatReducer()
        let agentState = ChatRecords.permissionState()
        _ = state.reduce([], agentState: agentState)
        XCTAssertTrue(state.reduce([], agentState: agentState).messages.isEmpty)
        XCTAssertEqual(state.messages.count, 1)
    }

    func testPrioritizesToolCallOverPermissionWhenProvidedSimultaneously() throws {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.call("start")], agentState: ChatRecords.permissionState())
        let row = try ChatRecords.toolRow(state.messages)
        XCTAssertEqual(state.messages.count, 1)
        XCTAssertEqual(row.tool.startedAt, 100)
        XCTAssertEqual(row.turn, "turn")
    }

    func testPreservesOriginalTimestampWhenRequestReceivedFirstThenToolCall() throws {
        var state = ChatReducer()
        _ = state.reduce([], agentState: ChatRecords.permissionState())
        _ = state.reduce([ChatRecords.call("start", at: 200)])
        let row = try ChatRecords.toolRow(state.messages)
        XCTAssertEqual(row.createdAt, 50)
        XCTAssertEqual(row.tool.createdAt, 50)
        XCTAssertEqual(row.tool.startedAt, 200)
    }

    func testCreatesSeparateMessagesForSameToolNameWithDifferentIds() {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.call("a", call: "a"), ChatRecords.call("b", call: "b")])
        XCTAssertEqual(state.messages.count, 2)
    }

    func testHandlesFullPermissionLifecyclePendingApprovedExecutionCompletion() throws {
        var state = ChatReducer()
        _ = state.reduce([], agentState: ChatRecords.permissionState())
        _ = state.reduce([], agentState: ChatRecords.permissionState(status: "approved"))
        _ = state.reduce([ChatRecords.call("start")])
        _ = state.reduce([ChatRecords.result("end")])
        let row = try ChatRecords.toolRow(state.messages)
        XCTAssertEqual(row.tool.state, .completed)
        XCTAssertEqual(row.tool.permission?.status, .approved)
        XCTAssertEqual(row.tool.result, .string("done"))
    }

    func testHandlesDeniedAndCanceledPermissionsCorrectly() throws {
        for status in ["denied", "canceled"] {
            var state = ChatReducer()
            _ = state.reduce([], agentState: ChatRecords.permissionState())
            _ = state.reduce(
                [],
                agentState: ChatRecords.permissionState(status: status, extra: ["reason": .string("refused")])
            )
            let row = try ChatRecords.toolRow(state.messages)
            XCTAssertEqual(row.tool.state, .error)
            XCTAssertEqual(row.tool.result, .object(["error": .string("refused")]))
        }
    }

    func testHandlesToolResultArrivingBeforeToolCallRaceCondition() throws {
        var state = ChatReducer()
        XCTAssertTrue(state.reduce([ChatRecords.result("early")]).messages.isEmpty)
        // Unlike the RN reducer's drop, disk-first delta replay must retain
        // a result that arrived over the socket before its missing call.
        _ = state.reduce([ChatRecords.call("start")])
        XCTAssertEqual(try ChatRecords.toolRow(state.messages).tool.state, .completed)
        _ = state.reduce([ChatRecords.result("retry")])
        XCTAssertEqual(try ChatRecords.toolRow(state.messages).tool.state, .completed)
    }

    func testJoinsToolResultBeforeCallWithinOneBatch() throws {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.result("end"), ChatRecords.call("start")])
        XCTAssertEqual(try ChatRecords.toolRow(state.messages).tool.state, .completed)
    }

    func testDoesNotAllowMultipleToolResultsForSameToolId() throws {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.call("start"), ChatRecords.result("end")])
        _ = state.reduce([ChatRecords.result("extra", error: true, result: "changed")])
        XCTAssertEqual(try ChatRecords.toolRow(state.messages).tool.result, .string("done"))
    }

    func testDoesNotDowngradeApprovedPermissionWhenAgentStateHasBoth() throws {
        var state = ChatReducer()
        let pending = ChatRecords.permissionState()["requests"]!
        let complete = ChatRecords.permissionState(status: "approved")["completedRequests"]!
        _ = state.reduce([], agentState: .object(["requests": pending, "completedRequests": complete]))
        XCTAssertEqual(try ChatRecords.toolRow(state.messages).tool.permission?.status, .approved)
    }

    func testHandlesAppLoadingFlowToolFirstThenApprovedDeniedOrCanceledPermission() throws {
        for status in ["approved", "denied", "canceled"] {
            var state = ChatReducer()
            _ = state.reduce([ChatRecords.call("start")])
            _ = state.reduce([], agentState: ChatRecords.permissionState(status: status))
            let row = try ChatRecords.toolRow(state.messages)
            XCTAssertEqual(row.tool.permission?.status.rawValue, status)
            XCTAssertEqual(row.tool.state, status == "approved" ? .running : .error)
        }
    }

    func testHandlesFinishedToolsWithoutOverwritingResultsOrExecutionState() throws {
        for error in [false, true] {
            for status in ["approved", "denied"] {
                var state = ChatReducer()
                _ = state.reduce([ChatRecords.call("start"), ChatRecords.result("end", error: error)])
                _ = state.reduce([], agentState: ChatRecords.permissionState(status: status))
                let row = try ChatRecords.toolRow(state.messages)
                XCTAssertEqual(row.tool.state, error ? .error : .completed)
                XCTAssertEqual(row.tool.result, .string("done"))
                XCTAssertEqual(row.tool.permission?.status.rawValue, status)
            }
        }
    }

    func testKeepsCanonicalScopedPermissionRequestIdAndAllowToolsDecision() throws {
        var state = ChatReducer()
        _ = state.reduce(
            [ChatRecords.call("start")],
            agentState: ChatRecords.permissionState(
                "subagent:call", status: "approved",
                extra: [
                    "toolUseId": .string("call"), "allowTools": .array([.string("Bash")]),
                    "decision": .string("approved_for_session"),
                ]))
        let row = try ChatRecords.toolRow(state.messages)
        XCTAssertEqual(row.tool.permission?.id, "subagent:call")
        XCTAssertEqual(row.tool.permission?.allowedTools, ["Bash"])
    }

    func testSetsHasReadyEventWithoutCreatingVisibleMessages() {
        var state = ChatReducer()
        let event = ChatRecords.agentEvent("r", event: ChatRecords.json(#"{"type":"ready"}"#))
        XCTAssertTrue(state.reduce([event]).hasReadyEvent)
        XCTAssertTrue(state.messages.isEmpty)
        XCTAssertFalse(state.reduce([event]).hasReadyEvent)
    }

    func testHidesTurnStartLifecycleMessages() {
        var state = ChatReducer()
        _ = state.reduce([
            ChatRecords.agentEvent(
                "r", event: ChatRecords.json(#"{"type":"message","message":"Turn started"}"#))
        ])
        XCTAssertTrue(state.messages.isEmpty)
    }

    func testNestsSubagentLinkedMessagesUnderParentToolCalls() throws {
        var state = ChatReducer()
        _ = state.reduce([
            ChatRecords.call("task", call: "subagent", name: "Task"),
            ChatRecords.text("child", parent: "subagent"),
            ChatRecords.call("child-call", call: "nested", parent: "subagent"),
            ChatRecords.result("child-result", call: "nested", parent: "subagent"),
        ])
        let root = try ChatRecords.toolRow(state.messages)
        XCTAssertEqual(state.messages.count, 1)
        XCTAssertEqual(root.children.count, 2)
        XCTAssertEqual(try ChatRecords.toolRow(root.children).tool.state, .completed)
    }

    func testBuffersGeminiResultsAndTerminalOutputUntilCallArrives() throws {
        for data in [
            #"{"type":"tool-result","id":"result","callId":"call","output":"done"}"#,
            #"{"type":"terminal-output","callId":"call","data":"done"}"#,
        ] {
            var state = ChatReducer()
            let raw = JSONValue.object([
                "role": .string("agent"),
                "content": .object([
                    "type": .string("acp"), "provider": .string("gemini"),
                    "data": ChatRecords.json(data),
                ]),
            ])
            _ = state.reduce([ChatRecords.normalized("result", at: 200, raw: raw)])
            _ = state.reduce([ChatRecords.call("start")])
            let row = try ChatRecords.toolRow(state.messages)
            XCTAssertEqual(row.tool.state, .completed)
            XCTAssertEqual(row.tool.result, .string("done"))
            XCTAssertEqual(row.tool.completedAt, 200)
        }
    }

    func testRetainsFirstBufferedOutcomeAcrossResultDuplicates() throws {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.result("first", error: true, result: "failed")])
        _ = state.reduce([ChatRecords.result("duplicate", result: "different")])
        _ = state.reduce([ChatRecords.call("start")])
        let row = try ChatRecords.toolRow(state.messages)
        XCTAssertEqual(row.tool.state, .error)
        XCTAssertEqual(row.tool.result, .string("failed"))
    }

    func testReparentsOrphanedChildWhenOwnerArrivesInLaterBatch() throws {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.text("child", parent: "subagent")])
        XCTAssertEqual(state.messages.count, 1)
        _ = state.reduce([ChatRecords.call("owner", input: .object(["sessionSubagent": .string("subagent")]))]
        )
        let root = try ChatRecords.toolRow(state.messages)
        XCTAssertEqual(state.messages.count, 1)
        XCTAssertEqual(root.children.map(\.id), ["child:0"])
    }

    func testReparentsNestedOrphanToolsAndRetainsBufferedResult() throws {
        var state = ChatReducer()
        _ = state.reduce([ChatRecords.result("end", call: "inner")])
        _ = state.reduce([ChatRecords.call("nested", call: "inner", parent: "subagent")])
        _ = state.reduce([ChatRecords.text("deep", parent: "inner")])
        _ = state.reduce([ChatRecords.call("owner", call: "subagent")])
        let nested = try ChatRecords.toolRow(try ChatRecords.toolRow(state.messages).children)
        XCTAssertEqual(state.messages.count, 1)
        XCTAssertEqual(nested.children.count, 1)
        XCTAssertEqual(nested.tool.state, .completed)
    }

    func testNestsAgentSidechainsViaSessionSubagentAndSuppressesDuplicatedPromptEcho() throws {
        var state = ChatReducer()
        _ = state.reduce([
            ChatRecords.call(
                "task", name: "Agent",
                input: ChatRecords.json(#"{"sessionSubagent":"subagent","prompt":"Search files"}"#)),
            ChatRecords.text("echo", parent: "subagent", text: " Search files "),
            ChatRecords.text("child", parent: "subagent", text: "Found files"),
        ])
        let root = try ChatRecords.toolRow(state.messages)
        XCTAssertEqual(state.messages.count, 1)
        XCTAssertEqual(root.children.count, 1)
    }

    func testNestsCodexSubagentSidechainsViaSessionSubagent() throws {
        var state = ChatReducer()
        _ = state.reduce([
            ChatRecords.call(
                "task", name: "CodexSubagent", input: ChatRecords.json(#"{"sessionSubagent":"subagent"}"#))
        ])
        _ = state.reduce([ChatRecords.text("child", parent: "subagent")])
        XCTAssertEqual(try ChatRecords.toolRow(state.messages).children.count, 1)
    }

    func testSidechainUpdatesReemitRootAndNestRecursively() throws {
        var state = ChatReducer()
        _ = state.reduce([
            ChatRecords.call("task", call: "subagent"),
            ChatRecords.call("nested", call: "inner", parent: "subagent"),
        ])
        let update = state.reduce([ChatRecords.text("deep", parent: "inner")])
        XCTAssertEqual(update.messages.count, 1)
        XCTAssertEqual(
            try ChatRecords.toolRow(try ChatRecords.toolRow(state.messages).children).children.count, 1)
    }

    func testDoesNotUpdateTodosFromRunningTodoWriteInput() {
        var state = ChatReducer()
        _ = state.reduce([
            ChatRecords.call(
                "todo", name: "TodoWrite",
                input: ChatRecords.json(#"{"todos":[{"content":"Task","status":"pending"}]}"#))
        ])
        XCTAssertNil(state.todos)
    }

    func testUpdatesTodosFromSuccessfulTodoWriteResultNewTodos() {
        var state = ChatReducer()
        var result = ChatRecords.result("result")
        let value = ChatRecords.json(
            #"{"newTodos":[{"content":"Task","status":"completed","priority":"high","id":"1"}]}"#)
        result.body = .agent([.result(id: "call", value: value, error: false)])
        _ = state.reduce([ChatRecords.call("todo", name: "TodoWrite"), result])
        XCTAssertEqual(state.todos, value["newTodos"])
    }

    func testIgnoresMalformedTodoWriteResult() {
        var state = ChatReducer()
        var result = ChatRecords.result("result")
        result.body = .agent([
            .result(id: "call", value: ChatRecords.json(#"{"newTodos":[{"status":"wrong"}]}"#), error: false)
        ])
        _ = state.reduce([ChatRecords.call("todo", name: "TodoWrite"), result])
        XCTAssertNil(state.todos)
    }

    func testRejectsMalformedOptionalTodoPriorityAndId() {
        for item in [
            #"{"content":"Task","status":"pending","priority":"unknown"}"#,
            #"{"content":"Task","status":"pending","id":1}"#,
        ] {
            var state = ChatReducer()
            var result = ChatRecords.result("result")
            result.body = .agent([
                .result(
                    id: "call", value: .object(["newTodos": .array([ChatRecords.json(item)])]), error: false)
            ])
            _ = state.reduce([ChatRecords.call("todo", name: "TodoWrite"), result])
            XCTAssertNil(state.todos)
        }
    }

    func testExtremeUsageCountsCannotCrashReduction() throws {
        var state = ChatReducer()
        var record = ChatRecords.text("usage")
        record.usage = try JSONDecoder().decode(
            SessionUsage.self,
            from: Data(
                #"{"input_tokens":9223372036854775807,"output_tokens":1,"cache_read_input_tokens":1}"#.utf8))
        _ = state.reduce([record])
        XCTAssertEqual(state.usage?.contextSize, .max)
    }

    func testUpdatesLatestUsageFromUsageOnlyMessagesAndPreservesContextWindow() {
        var state = ChatReducer()
        let raw = ChatRecords.session(
            "u", at: 400, turn: nil, event: ChatRecords.json(#"{"t":"service","text":""}"#),
            extra: [
                "usage": ChatRecords.json(
                    #"{"input_tokens":12,"output_tokens":4,"cache_creation_input_tokens":3,"cache_read_input_tokens":5,"context_window":200000}"#
                )
            ])
        _ = state.reduce([ChatRecords.normalized("u", raw: raw)])
        XCTAssertEqual(state.usage?.contextSize, 20)
        XCTAssertEqual(state.usage?.contextWindow, 200000)
        XCTAssertTrue(state.messages.isEmpty)
        var older = ChatRecords.normalized("old", raw: raw)
        older.id = "old"
        older.createdAt = 100
        _ = state.reduce([older])
        XCTAssertEqual(state.usage?.inputTokens, 12)
    }

    func testContextResetAndCompactionCompletedClearUsage() {
        for event in ["Context was reset", "Compaction completed"] {
            var state = ChatReducer()
            _ = state.reduce([
                ChatRecords.agentEvent(
                    "r", event: .object(["type": .string("message"), "message": .string(event)]))
            ])
            XCTAssertEqual(state.usage?.contextSize, 0)
            if event == "Context was reset" {
                XCTAssertEqual(state.todos, .array([]))
            }
        }
    }

    func testOlderResetAndCompactionCannotDiscardNewerUsageOrTodos() throws {
        for event in ["Context was reset", "Compaction completed"] {
            var state = ChatReducer()
            var usage = ChatRecords.text("usage", at: 400)
            usage.usage = try JSONDecoder().decode(SessionUsage.self, from: Data(
                #"{"input_tokens":12,"output_tokens":4,"context_window":200000}"#.utf8))
            var result = ChatRecords.result("todos")
            result.createdAt = 500
            let todos = ChatRecords.json(#"[{"content":"Current task","status":"pending"}]"#)
            result.body = .agent([.result(id: "call", value: .object(["newTodos": todos]), error: false)])
            _ = state.reduce([usage, ChatRecords.call("todo", name: "TodoWrite"), result])
            let newestUsage = state.usage
            XCTAssertNotNil(newestUsage)
            XCTAssertEqual(state.todos, todos)
            var older = ChatRecords.agentEvent("old", event: .object([
                "type": .string("message"), "message": .string(event),
            ]))
            older.createdAt = 100
            _ = state.reduce([older])
            XCTAssertEqual(state.usage, newestUsage, event)
            XCTAssertEqual(state.todos, todos, event)
            XCTAssertTrue(state.messages.contains { $0.id == "old" }, "older reset remains a visible event")
        }
    }

    func testResetUsesIndependentUsageAndTodosTimestamps() throws {
        var state = ChatReducer()
        var usage = ChatRecords.text("usage", at: 400)
        usage.usage = try JSONDecoder().decode(SessionUsage.self, from: Data(#"{"input_tokens":12,"output_tokens":4}"#.utf8))
        var result = ChatRecords.result("todos")
        result.createdAt = 600
        let todos = ChatRecords.json(#"[{"content":"New task","status":"pending"}]"#)
        result.body = .agent([.result(id: "call", value: .object(["newTodos": todos]), error: false)])
        _ = state.reduce([usage, ChatRecords.call("todo", name: "TodoWrite"), result])
        var reset = ChatRecords.agentEvent("reset", event: .object([
            "type": .string("message"), "message": .string("Context was reset"),
        ]))
        reset.createdAt = 500
        _ = state.reduce([reset])
        XCTAssertEqual(state.usage?.contextSize, 0)
        XCTAssertEqual(state.todos, todos, "a reset newer than usage is still older than the latest todos")
        reset.id = "new-reset"
        reset.createdAt = 600
        _ = state.reduce([reset])
        XCTAssertEqual(state.todos, todos, "equal timestamps preserve the already accepted todos")
        reset.id = "latest-reset"
        reset.createdAt = 601
        _ = state.reduce([reset])
        XCTAssertEqual(state.todos, .array([]))
    }

    func testEqualTimestampOlderResetRetainsAcceptedUsage() throws {
        for event in ["Context was reset", "Compaction completed"] {
            var state = ChatReducer()
            var usage = ChatRecords.text("usage", at: 400)
            usage.usage = try JSONDecoder().decode(SessionUsage.self,
                from: Data(#"{"input_tokens":12,"output_tokens":4}"#.utf8))
            _ = state.reduce([usage])
            let accepted = state.usage
            let reset = ChatRecords.agentEvent("reset", at: 400, event: .object([
                "type": .string("message"), "message": .string(event),
            ]))
            _ = state.reduce([reset])
            XCTAssertEqual(state.usage, accepted, event)
        }
    }

    func testMessageToEventConversionSkipsToolRowsAndResults() {
        for record in [
            ChatRecords.call(
                "title", name: "mcp__happy__change_title", input: .object(["title": .string("New")])),
            ChatRecords.call("plan", name: "EnterPlanMode"),
            ChatRecords.text("limit", text: "Claude AI usage limit reached|123"),
        ] {
            var state = ChatReducer()
            _ = state.reduce([record])
            XCTAssertEqual(state.messages.count, 1)
            guard case .agentEvent = state.messages[0] else {
                return XCTFail("converted event")
            }
        }
    }
}
