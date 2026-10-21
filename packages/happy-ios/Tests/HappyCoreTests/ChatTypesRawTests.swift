import XCTest
import HappyWire
@testable import HappyCore

/// Current-format cases from typesRaw.spec.ts; retired output/codex cases
/// deliberately assert placeholders instead of retaining obsolete decoders.
final class ChatTypesRawTests: XCTestCase {
    func testNormalizesTextEventsToAgentTextContent() {
        let record = ChatRecords.text("id")
        XCTAssertEqual(record.body, .agent([.text("answer", thinking: false)]))
        XCTAssertEqual(record.id, "id")
        XCTAssertEqual(record.createdAt, 100)
    }

    func testNormalizesNewDirectAndWrappedSessionRoleEnvelopeShapes() {
        let direct = ChatRecords.text("id").raw
        let wrapped = JSONValue.object([
            "role": .string("session"),
            "content": .object(["type": .string("session"), "data": direct["content"]!]),
        ])
        XCTAssertEqual(
            ChatRecords.normalized("server", raw: wrapped).body,
            ChatRecords.normalized("server", raw: direct).body)
        if case .session(let envelope, _) = MessageContent(decrypted: wrapped) {
            XCTAssertEqual(envelope.id, "id")
        } else {
            XCTFail("wrapped session")
        }
    }

    func testNormalizesThinkingTextEvents() {
        XCTAssertEqual(ChatRecords.text("id", thinking: true).body, .agent([.text("answer", thinking: true)]))
    }

    func testRendersSessionProtocolUserTextEnvelopes() {
        let raw = ChatRecords.session(
            "id", role: "user", turn: nil, event: ChatRecords.json(#"{"t":"text","text":"hello"}"#),
            extra: ["claudeUuid": .string("uuid"), "codexItemId": .string("item")])
        let record = ChatRecords.normalized("server", raw: raw)
        XCTAssertEqual(record.body, .user("hello"))
        XCTAssertEqual(record.claudeUuid, "uuid")
        XCTAssertEqual(record.codexItemId, "item")
    }

    func testRendersUserRoleMessagesWithEveryMetaField() {
        let raw = ChatRecords.json(
            #"""
            {
                "role": "user",
                "content": { "type": "text", "text": "hello" },
                "meta": {
                    "sentFrom": "ios", "expectsAcceptance": true,
                    "queuedWhileBusy": true, "permissionMode": "plan",
                    "model": "m", "modelProviderId": "p", "fallbackModel": "f",
                    "customSystemPrompt": "custom", "appendSystemPrompt": "append",
                    "allowedTools": ["Bash"], "disallowedTools": ["Write"],
                    "effort": "high", "serviceTier": "fast", "displayText": "visible"
                }
            }
            """#
        )
        let record = ChatRecords.normalized("id", raw: raw)
        let meta = record.meta
        XCTAssertEqual(meta?.sentFrom, "ios")
        XCTAssertEqual(meta?.expectsAcceptance, true)
        XCTAssertEqual(meta?.queuedWhileBusy, true)
        XCTAssertEqual(meta?.permissionMode, "plan")
        XCTAssertEqual(meta?.model, "m")
        XCTAssertEqual(meta?.modelProviderId, "p")
        XCTAssertEqual(meta?.fallbackModel, "f")
        XCTAssertEqual(meta?.customSystemPrompt, "custom")
        XCTAssertEqual(meta?.appendSystemPrompt, "append")
        XCTAssertEqual(meta?.allowedTools, ["Bash"])
        XCTAssertEqual(meta?.disallowedTools, ["Write"])
        XCTAssertEqual(meta?.effort, "high")
        XCTAssertEqual(meta?.serviceTier, "fast")
        XCTAssertEqual(meta?.displayText, "visible")
    }

    func testPreservesSessionProtocolUsageForContextTracking() {
        let raw = ChatRecords.session(
            "id", event: ChatRecords.json(#"{"t":"text","text":"answer"}"#),
            extra: [
                "usage": ChatRecords.json(
                    #"{"input_tokens":12,"output_tokens":5,"cache_read_input_tokens":8,"context_window":200000}"#
                )
            ])
        let record = ChatRecords.normalized("id", raw: raw)
        XCTAssertEqual(record.usage?.inputTokens, 12)
        XCTAssertEqual(record.usage?.contextWindow, 200000)
    }

    func testNormalizesUsageOnlyServiceEnvelopesWithoutChatContentOrTurn() {
        let raw = ChatRecords.session(
            "id", turn: nil, event: ChatRecords.json(#"{"t":"service","text":" "}"#),
            extra: ["usage": ChatRecords.json(#"{"input_tokens":1,"output_tokens":2}"#)])
        XCTAssertEqual(ChatRecords.normalized("id", raw: raw).body, .agent([]))
    }

    func testDropsPersistedControlOnlyTaskNotificationsForUserAndAgentEnvelopes() {
        for role in ["user", "agent"] {
            let raw = ChatRecords.session(
                "id", role: role,
                event: .object([
                    "t": .string("text"),
                    "text": .string(
                        "<task-notification>nested <task-notification>x</task-notification></task-notification>"
                    ),
                ]))
            XCTAssertNil(ChatNormalizer.normalize(id: "id", createdAt: 0, raw: raw))
        }
    }

    func testPreservesVisibleTextAfterPersistedTaskNotificationWrapper() {
        XCTAssertEqual(
            ChatNormalizer.stripTaskNotifications("  <task-notification>x</task-notification>\nVisible"),
            "Visible")
        XCTAssertEqual(
            ChatNormalizer.stripTaskNotifications("<task-notification>unfinished"),
            "<task-notification>unfinished")
        XCTAssertEqual(
            ChatNormalizer.stripTaskNotifications("Explain <task-notification> wrappers"),
            "Explain <task-notification> wrappers")
    }

    func testNormalizesServiceEventsToVisibleAgentText() {
        let raw = ChatRecords.session("id", event: ChatRecords.json(#"{"t":"service","text":"Service"}"#))
        XCTAssertEqual(
            ChatRecords.normalized("id", raw: raw).body, .agent([.text("Service", thinking: false)]))
    }

    func testNormalizesToolCallLifecycleEvents() {
        guard case .agent(let blocks) = ChatRecords.call("id").body, blocks.count == 1,
            case .call(let id, let name, let title, _, let description) = blocks[0]
        else {
            return XCTFail("call")
        }
        XCTAssertEqual(id, "call")
        XCTAssertEqual(name, "Bash")
        XCTAssertEqual(title, "Run command")
        XCTAssertEqual(description, "description")
        XCTAssertEqual(
            ChatRecords.result("end").body,
            .agent([.result(id: "call", value: .string("done"), error: false)]))
    }

    func testMapsTurnEndToReadyEventAndDropsTurnStart() {
        let end = ChatRecords.session(
            "end", event: ChatRecords.json(#"{"t":"turn-end","status":"completed"}"#))
        XCTAssertEqual(ChatRecords.normalized("end", raw: end).body, .event(.ready))
        XCTAssertNil(
            ChatNormalizer.normalize(
                id: "start", createdAt: 0,
                raw: ChatRecords.session("start", event: ChatRecords.json(#"{"t":"turn-start"}"#))))
    }

    func testNormalizesFileEventsWithRequiredSizeAndOptionalImageMetadata() throws {
        for event in [
            #"{"t":"file","ref":"f","name":"a.pdf","size":12}"#,
            #"{"t":"file","ref":"f","name":"a.png","size":12,"image":{"width":20,"height":30}}"#,
        ] {
            let raw = ChatRecords.session("file", role: "user", turn: nil, event: ChatRecords.json(event))
            var reducer = ChatReducer()
            _ = reducer.reduce([ChatRecords.normalized("file", raw: raw)])
            let row = try ChatRecords.toolRow(reducer.messages)
            XCTAssertEqual(row.tool.state, .completed)
            XCTAssertEqual(row.tool.result, .null)
            XCTAssertEqual(row.tool.input["size"], .number(12))
        }
    }

    func testRejectsMalformedCurrentFormatsWithVisiblePlaceholders() {
        let events = [
            #"{"t":"file","ref":"f","name":"a"}"#, #"{"t":"turn-end"}"#,
            #"{"t":"tool-call-start","call":"c","name":"Bash","title":"title","description":"d"}"#,
            #"{"t":"text"}"#,
        ]
        for event in events {
            let record = ChatRecords.normalized(
                "id", raw: ChatRecords.session("id", event: ChatRecords.json(event)))
            guard case .unsupported = record.body else {
                return XCTFail("malformed current format must remain visible")
            }
        }
    }

    func testMarksSubagentLinkedMessagesAsSidechainMessages() {
        XCTAssertEqual(ChatRecords.text("id", parent: "subagent").parent, "subagent")
    }

    func testDropsStartStopLifecycleMarkers() {
        for kind in ["start", "stop"] {
            XCTAssertNil(
                ChatNormalizer.normalize(
                    id: "id", createdAt: 0,
                    raw: ChatRecords.session("id", event: .object(["t": .string(kind)]))))
        }
    }

    func testRejectsNonCuidSubagentIdentifiers() {
        guard case .unsupported = ChatRecords.text("id", parent: "not-a-cuid").body else {
            return XCTFail("invalid subagent")
        }
    }

    func testAcceptsAcceptanceReceiptsWhichBelongToNoTurn() {
        XCTAssertEqual(ChatRecords.receipt("r", ref: "s").body, .event(.userMessageAccepted(ref: "s")))
    }

    func testCarriesTurnAndAuthor() {
        let raw = ChatRecords.session(
            "id", role: "user", event: ChatRecords.json(#"{"t":"text","text":"hi"}"#),
            extra: ["author": ChatRecords.json(#"{"id":"a","name":"Alex","owner":false}"#)])
        XCTAssertEqual(
            ChatRecords.normalized("id", raw: raw).author, SessionAuthor(id: "a", name: "Alex", owner: false))
        XCTAssertEqual(ChatRecords.text("agent").turn, "turn")
    }

    func testRejectsAgentEventsWithoutTurnAndServiceEventsFromUserRole() {
        for raw in [
            ChatRecords.session("id", turn: nil, event: ChatRecords.json(#"{"t":"text","text":"answer"}"#)),
            ChatRecords.session(
                "id", role: "user", event: ChatRecords.json(#"{"t":"service","text":"service"}"#)),
        ] {
            guard case .unsupported = ChatRecords.normalized("id", raw: raw).body else {
                return XCTFail("unsupported")
            }
        }
    }

    func testCurrentAgentEventsAndGeminiACPFormats() {
        let events = [
            #"{"type":"switch","mode":"local"}"#, #"{"type":"message","message":"hi"}"#,
            #"{"type":"limit-reached","endsAt":500}"#, #"{"type":"ready"}"#,
            #"{"type":"user-message-accepted","ref":"s"}"#,
            #"{"type":"user-message-rejected","ref":"s","reason":"no"}"#,
        ]
        for event in events {
            guard case .event = ChatRecords.agentEvent("e", event: ChatRecords.json(event)).body else {
                return XCTFail("event")
            }
        }
        let data = [
            #"{"type":"message","message":"hi"}"#, #"{"type":"reasoning","message":"hmm"}"#,
            #"{"type":"thinking","text":"hmm"}"#,
            #"{"type":"tool-call","callId":"c","id":"id","name":"Bash","input":{}}"#,
            #"{"type":"tool-result","callId":"c","id":"id","output":"done","isError":true}"#,
            #"{"type":"tool-call-result","callId":"c","id":"id","output":"done"}"#,
            #"{"type":"file-edit","filePath":"/a","description":"edit","id":"id"}"#,
            #"{"type":"terminal-output","callId":"c","data":"done"}"#,
            #"{"type":"permission-request","permissionId":"c","toolName":"Bash","description":"d"}"#,
        ]
        for item in data {
            let raw = JSONValue.object([
                "role": .string("agent"),
                "content": .object([
                    "type": .string("acp"), "provider": .string("gemini"), "data": ChatRecords.json(item),
                ]),
            ])
            guard case .agent = ChatRecords.normalized("id", raw: raw).body else {
                return XCTFail("ACP \(item)")
            }
        }
    }

    func testACPStatusAndMetricsDoNotRenderRows() {
        for kind in ["task_started", "task_complete", "turn_aborted", "token_count", "token-count"] {
            let raw = JSONValue.object([
                "role": .string("agent"),
                "content": .object([
                    "type": .string("acp"), "provider": .string("gemini"),
                    "data": .object(["type": .string(kind), "id": .string("id")]),
                ]),
            ])
            XCTAssertNil(ChatNormalizer.normalize(id: "id", createdAt: 0, raw: raw))
        }
    }

    func testRetiredClaudeOutputCodexAndUnknownRecordsRenderUnsupported() {
        for kind in ["output", "codex", "new-format"] {
            let raw = ChatRecords.json(
                "{\"role\":\"agent\",\"content\":{\"type\":\"\(kind)\",\"data\":{\"type\":\"message\",\"message\":\"old\"}}}"
            )
            guard case .unsupported(let name) = ChatRecords.normalized("id", raw: raw).body else {
                return XCTFail("retired")
            }
            XCTAssertTrue(name.contains(kind))
        }
    }

    func testPreservesUnknownFieldsThroughNormalization() {
        let raw = ChatRecords.session(
            "id", event: ChatRecords.json(#"{"t":"text","text":"hi","future":{"signature":"sig"}}"#))
        XCTAssertEqual(ChatRecords.normalized("id", raw: raw).raw, raw)
    }
}
