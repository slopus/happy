#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
// The fixtures: in Debug, and in builds that ask for them (HAPPY_FIXTURES,
// the hosted tests in Preview). Never in the shipped app.
import Foundation
import HappyCore
import HappyStore
import HappyWire

/// The fixture chats: each one stresses a different part of the screen.
enum FixtureScenario: String, CaseIterable, Sendable {
    /// Every markdown block: headers, lists, code, tables, options, links.
    case markdown
    /// Tool calls of every kind, with pending, denied and failed permissions.
    case tools
    /// The agent is waiting on an AskUserQuestion.
    case question
    /// Queued, sending, failed and refused messages at the bottom.
    case sending
    /// Thousands of messages, for scrolling and paging back.
    case long
    /// A reply streams in after the chat opens.
    case live
    /// Nothing yet.
    case empty

    var title: String {
        switch self {
        case .markdown: "Markdown showcase"
        case .tools: "Tool calls and permissions"
        case .question: "Agent question"
        case .sending: "Pending and failed sends"
        case .long: "Very long session"
        case .live: "Streaming reply"
        case .empty: "Empty session"
        }
    }
}

enum FixtureScenarios {
    /// 2026-10-01T09:00:00Z, so fixture times read like a recent session.
    static let now: Int64 = 1_790_845_200_000

    static let prefix = "fixture:"

    static func isFixture(_ sessionId: String) -> Bool {
        sessionId.hasPrefix(prefix)
    }

    static func scenario(for sessionId: String) -> FixtureScenario {
        FixtureScenario(rawValue: String(sessionId.dropFirst(prefix.count))) ?? .markdown
    }

    /// The store has no record for a fixture session; this stands in.
    static func record(sessionId: String) -> SessionRecord {
        let scenario = scenario(for: sessionId)
        var metadata: [String: Any] = [
            "path": "/Users/fixture/happy",
            "homeDir": "/Users/fixture",
            "host": "fixture-mac",
            "os": "darwin",
            "gitBranch": "main",
            "name": scenario.title,
            "summary": ["text": scenario.title],
            "flavor": "claude",
            "claudeSessionId": "fixture-claude",
        ]
        if scenario == .live {
            // The goal bar's run, and RigActivityBar's counts.
            metadata["client"] = ["id": "rig", "name": "Happy Agent"]
            metadata["activity"] = [
                "subagents": ["running": 2, "queued": 1],
                "workflows": ["running": 0],
                "processes": ["running": 1],
                "tasks": ["pending": 3, "inProgress": 1],
            ]
        }
        return SessionRecord(
            id: sessionId, seq: 1, createdAt: now, updatedAt: now, active: true, activeAt: now, projectId: nil,
            metadataVersion: 1, metadataCipher: "",
            metadata: json(metadata),
            agentStateVersion: 1, agentStateCipher: nil, agentState: json(agentState(scenario)),
            dataKeyCipher: nil, decryptable: true, thinking: scenario == .live
        )
    }

    /// The question scenario's agent is also waiting on a form joined to
    /// its request_user_input call, a written answer (the banner and the
    /// answer sheet) and a kind this build doesn't know.
    static func agentState(_ scenario: FixtureScenario) -> [String: Any] {
        if scenario == .live {
            return [
                "controlledByUser": false,
                "agentGoalStatus": [
                    "status": "active", "source": "claude", "sourceSessionId": "fixture-claude", "observedAt": Int(now),
                    "text": "Ship the native chat screen to TestFlight with every fixture passing",
                    "capabilities": ["edit": true, "stop": true, "clear": true],
                ],
            ]
        }
        // The sending scenario has the terminal in control, for ChatFooter.
        guard scenario == .question else { return ["controlledByUser": scenario == .sending] }
        return [
            "controlledByUser": false,
            "communications": [
                questionCallId: [
                    "kind": "form", "createdAt": 3, "toolUseId": questionCallId,
                    "form": ["questions": [[
                        "id": "platform", "header": "Platform", "question": "Which devices should the build support?", "multiSelect": true,
                        "options": [["label": "iPhone", "description": "iOS 17 and later"], ["label": "iPad"], ["label": "Mac (Designed for iPad)"]],
                    ]]],
                ],
                "ask-name": [
                    "kind": "form", "createdAt": 1,
                    "form": ["questions": [[
                        "id": "name", "header": "Release name", "question": "What should this release be called?",
                    ], [
                        "id": "notes", "header": "Notes", "question": "Anything the testers should look at first?",
                        "options": [["label": "The chat list"], ["label": "The composer"]], "multiSelect": true, "required": false,
                    ]]],
                ],
                "approve-deploy": ["kind": "approval", "createdAt": 2, "title": "Approve the production deploy"],
            ],
        ]
    }

    static let questionCallId = "call-question-platform"

    static func messages(_ scenario: FixtureScenario, sessionId: String) -> [ChatMessage] {
        var builder = Builder()
        switch scenario {
        case .markdown: markdown(&builder)
        case .tools: tools(&builder)
        case .question: question(&builder)
        case .sending: sending(&builder)
        case .long: long(&builder, turns: 1500)
        case .live: live(&builder)
        case .empty: break
        }
        return builder.messages
    }

    /// Builds messages oldest first, a few seconds apart.
    struct Builder {
        var messages: [ChatMessage] = []
        var time: Int64 = FixtureScenarios.now - 86_400_000
        var counter = 0
        var turn = "turn-0"

        mutating func nextId(_ prefix: String) -> String {
            counter += 1
            return "\(prefix)-\(counter)"
        }

        mutating func advance(_ seconds: Int64 = 4) -> Int64 {
            time += seconds * 1000
            return time
        }

        mutating func user(_ text: String, author: SessionAuthor? = nil) {
            counter += 1
            turn = "turn-\(counter)"
            let at = advance(30)
            messages.append(.userText(UserTextMessage(id: "user-\(counter)", createdAt: at, text: text, author: author)))
        }

        mutating func agent(_ text: String) {
            let id = nextId("agent")
            messages.append(.agentText(AgentTextMessage(id: id, createdAt: advance(), turn: turn, text: text)))
        }

        mutating func thinking(_ text: String) {
            let id = nextId("thinking")
            messages.append(.agentText(AgentTextMessage(id: id, createdAt: advance(1), turn: turn, text: text, isThinking: true)))
        }

        mutating func event(_ event: AgentEvent) {
            let id = nextId("event")
            messages.append(.agentEvent(AgentEventMessage(id: id, createdAt: advance(1), turn: turn, event: event)))
        }

        mutating func unsupported(_ kind: String) {
            let id = nextId("unsupported")
            messages.append(.unsupported(UnsupportedMessage(id: id, createdAt: advance(1), kind: kind)))
        }

        mutating func tool(
            _ name: String, _ input: [String: Any], state: ToolCall.State = .completed, result: String? = nil,
            description: String? = nil, permission: ToolPermission? = nil, seconds: Int64 = 3, children: [ChatMessage] = [], callId: String? = nil
        ) {
            let id = nextId("tool")
            let started = advance(1)
            let completed = state == .running ? nil : started + seconds * 1000
            time = max(time, completed ?? started)
            messages.append(.toolCall(ToolCallMessage(id: id, createdAt: started, turn: turn, tool: ToolCall(
                callId: callId ?? "call-\(id)", name: name, state: state, input: json(input), createdAt: started,
                startedAt: started, completedAt: completed, description: description, result: result.map(JSONValue.string), permission: permission
            ), children: children)))
        }
    }

    // MARK: Scenarios

    static func markdown(_ b: inout Builder) {
        b.user("Can you explain how the **chat list** keeps its place while a reply streams in?")
        b.thinking("The reader wants the anchoring rules, with an example.")
        b.agent(markdownAnswer)
        b.user("Show me the same thing in TypeScript and Python, and a table of the thresholds.")
        b.agent(codeAnswer)
        b.user("""
        Two follow-ups:
        1. What happens on rotation?
        2. Does it work with the keyboard up?

        See https://developer.apple.com/documentation/uikit/uicollectionview for context.
        """)
        // FileView: two pictures with their thumbhashes, one without its
        // size that never arrives.
        b.tool("file", ["ref": "fixture-landscape", "name": "anchoring-before.png", "size": 48213, "image": ["width": 1200, "height": 675, "thumbhash": "HwgKPJxwd3dweHiHiHdwgAf3iA"]])
        b.tool("file", ["ref": "fixture-portrait", "name": "keyboard-up.png", "size": 31877, "image": ["width": 600, "height": 1010, "thumbhash": "W5eFGw43M0B3eHczQDjzi4+IiIiIiHg="]])
        b.tool("file", ["ref": "fixture-missing", "name": "a-picture-that-never-arrives-with-a-long-name.heic", "size": 1200])
        b.agent(optionsAnswer)
        b.event(.modeSwitch(mode: "plan"))
        b.unsupported("rig-artifact")
        b.user("/review")
        b.user("<command-message>review</command-message><command-name>/review</command-name><command-args>the anchoring change</command-args>")
        b.user("/goal ship the native chat list with stable anchoring")
        b.agent("Goal noted. I'll keep working until the list keeps its place in every case above.")
    }

    static func tools(_ b: inout Builder) {
        b.user("Find where the session list pushes the chat and wire the native screen in.")
        b.tool("Grep", ["pattern": "didSelectRowAt", "path": "packages/happy-ios/Sources"], result: "Sources/HappyUI/Screens/SessionListScreens.swift:189")
        b.tool("Read", ["file_path": "/Users/fixture/happy/packages/happy-ios/Sources/HappyUI/Navigation/Route.swift"], result: "enum Route: Hashable { … }")
        b.tool("Bash", ["command": "swift build -j 2", "description": "Build the package"], result: "Build complete! (41.20s)", description: "Build the package", seconds: 41)
        // Thousands of lines of output, for the tool's own screen.
        b.tool("Bash", ["command": "swift test --parallel", "description": "Run every test"], result: (
            (1...3000).map { "Test Case 'ChatLayoutTests.testRow\($0)' passed (0.00\($0 % 10) seconds)." }.joined(separator: "\n")
        ), description: "Run every test", seconds: 64)
        b.tool("Edit", [
            "file_path": "/Users/fixture/happy/packages/happy-ios/Sources/HappyUI/Navigation/Route.swift",
            "old_string": "case .session:\n    return PlaceholderViewController(title: \"\")",
            "new_string": "case .session(let id):\n    return ChatViewController(context: context, session: session, sessionId: id)",
        ], result: "The file has been updated.")
        b.tool("MultiEdit", [
            "file_path": "/Users/fixture/happy/packages/happy-ios/Sources/HappyUI/Chat/ChatViewController.swift",
            "edits": [
                ["old_string": "navigationItem.title = title", "new_string": "navigationItem.title = title\ntitleView.update(title: title)"],
                ["old_string": "private var pendingPin: String?", "new_string": "private var pendingPin: String?\nprivate var diffExpanded: [String: [Int: Set<Int>]] = [:]", "replace_all": true],
            ],
        ], result: "Applied 2 edits.")
        b.tool("Write", [
            "file_path": "/Users/fixture/happy/packages/happy-ios/docs/CHAT.md",
            "content": (1...120).map { "Line \($0) of the chat notes: every row is measured before it is shown." }.joined(separator: "\n"),
        ], result: "File created successfully.")
        b.tool("TodoWrite", ["todos": [
            ["content": "Wire the route", "status": "completed", "activeForm": "Wiring the route"],
            ["content": "Push from the session list", "status": "in_progress", "activeForm": "Pushing from the list"],
            ["content": "Run the tests", "status": "pending", "activeForm": "Running the tests"],
        ]])
        b.tool("mcp__linear__create_issue", ["title": "Native chat: anchoring regression test"], result: "Created HAP-1204")
        b.tool("WebFetch", ["url": "https://developer.apple.com/documentation/uikit/uiscrollview/contentinset", "prompt": "insets"], result: "…")
        let childAt = b.time
        b.tool("Task", ["description": "Audit keyboard handling", "prompt": "Check every inset path", "subagent_type": "general-purpose"], result: "No issues found.", seconds: 95, children: [
            .toolCall(ToolCallMessage(id: "child-1", createdAt: childAt, tool: ToolCall(name: "Read", state: .completed, input: json(["file_path": "ChatScreenLayout.swift"]), createdAt: childAt))),
        ])
        b.tool("apply_patch", ["input": "*** Begin Patch\n*** Update File: Sources/HappyUI/Chat/ChatListView.swift\n@@ func apply\n-        reloadData()\n+        performBatchUpdates(updates)\n*** End Patch", "workdir": "/Users/fixture/happy/packages/happy-ios"], result: "Success")
        // Codex's own shapes: a hunk-only diff, a new file's body, a move.
        b.tool("CodexPatch", ["changes": [
            "/Users/fixture/happy/packages/happy-ios/Sources/HappyUI/Chat/ChatServices.swift": [
                "kind": ["type": "update"],
                "unified_diff": "@@ -70,3 +70,4 @@\n     var observeSession: Observe\n-    var gitStatus: GitStatusSync?\n+    var gitStatus: GitStatusSync?\n+    var pendingChats: PendingChats\n     var setPermissionMode: SetMode",
            ],
            "/Users/fixture/happy/packages/happy-ios/docs/PATCHES.md": ["kind": ["type": "add"], "diff": "# Patches\n\nEvery file under its own header."],
            "/Users/fixture/happy/packages/happy-ios/Sources/Old.swift": [
                "kind": ["type": "update", "move_path": "/Users/fixture/happy/packages/happy-ios/Sources/New.swift"],
                "modify": ["old_content": "let name = \"old\"", "new_content": "let name = \"new\""],
            ],
        ]], result: "Success")
        b.tool("CodexDiff", [
            "unified_diff": "--- a/Sources/HappyUI/Chat/ChatServices.swift\n+++ b/Sources/HappyUI/Chat/ChatServices.swift\n@@ -1,2 +1,2 @@\n import Foundation\n-import HappyCore\n+@preconcurrency import HappyCore",
        ])
        b.tool("Bash", ["command": "swift test --filter Chat", "description": "Run the chat tests"], state: .error, result: "error: 2 tests failed", description: "Run the chat tests", seconds: 12)
        b.agent("Two tests failed because the fixture ids changed. I'll fix the expectations, then I need to push to your branch.")
        b.tool("Bash", ["command": "git push origin HEAD:chat-native", "description": "Push the branch"], state: .error,
               description: "Push the branch", permission: ToolPermission(id: "perm-denied", status: .denied, decision: .denied))
        b.tool("Write", ["file_path": "/Users/fixture/happy/packages/happy-ios/README.md", "content": "# Native chat"], state: .error,
               result: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>")
        b.tool("deploy_preview", ["environment": "staging", "ref": "chat-native", "notify": ["#ios", "#release"]], state: .running,
               permission: ToolPermission(id: "perm-deploy", status: .pending))
        b.agent("Understood, I won't push. Here is the plan for the remaining work.")
        b.tool("ExitPlanMode", ["plan": "1. Fix the two expectations\n2. Re-run `swift test`\n3. Report back"], state: .running,
               permission: ToolPermission(id: "perm-plan", status: .pending))
        b.tool("Edit", [
            "file_path": "/Users/fixture/happy/packages/happy-ios/Tests/HappyLayoutTests/ChatLayoutTests.swift",
            "old_string": "XCTAssertEqual(layout.newestEdgeInset, 170)",
            "new_string": "XCTAssertEqual(layout.newestEdgeInset, 172)",
        ], state: .running, permission: ToolPermission(id: "perm-edit", status: .pending))
        b.tool("Bash", ["command": "rm -rf .build && swift build", "description": "Clean build"], state: .running,
               description: "Clean build", permission: ToolPermission(id: "perm-bash", status: .pending))
    }

    static func question(_ b: inout Builder) {
        b.user("Set up the release for the native app.")
        b.tool("Read", ["file_path": "/Users/fixture/happy/.agents/skills/release/SKILL.md"], result: "…")
        b.agent("Before I start I need two decisions from you.")
        b.tool("AskUserQuestion", ["questions": [
            [
                "header": "Channel",
                "question": "Which channel should the first build go to?",
                "multiSelect": false,
                "options": [
                    ["label": "TestFlight", "description": "Internal testers only"],
                    ["label": "Preview", "description": "The preview OTA channel"],
                ],
            ],
            [
                "header": "Checks",
                "question": "Which checks should block the release?",
                "multiSelect": true,
                "options": [
                    ["label": "Unit tests", "description": "swift test on Linux"],
                    ["label": "Simulator build", "description": "The iOS simulator target"],
                    ["label": "Screenshots", "description": "Compare against happy-app"],
                ],
            ],
        ]], state: .running, permission: ToolPermission(id: "perm-question", status: .pending))
        b.tool("request_user_input", ["questions": [["id": "platform", "header": "Platform", "question": "Which devices should the build support?"]]],
               state: .running, callId: questionCallId)
    }

    static func sending(_ b: inout Builder) {
        b.user("Summarize what changed today.")
        b.agent("Three things changed: the list now anchors to the reader's row, streaming growth animates, and the composer docks to the keyboard.")
        b.user("Can you also check the Android build?", author: SessionAuthor(id: "other", name: "Sam Lee", owner: false))
        b.agent("The Android build is green.")
        let base = b.advance(10)
        b.messages.append(.userText(UserTextMessage(id: "refused", createdAt: base, text: "This one the daemon refused.", sendError: "Session is not running")))
        for (index, text) in ["Queued while offline", "Sending right now", "This one will fail to send"].enumerated() {
            let at = base + Int64(index + 1) * 1000
            b.messages.append(.userText(UserTextMessage(
                id: "pending-\(index)", localId: "pending-\(index)", createdAt: at, text: text, pending: true,
                sortAt: at + ChatMessage.pendingSortOffset
            )))
        }
    }

    static func live(_ b: inout Builder) {
        b.user("Walk me through the keyboard handling, step by step.")
        b.tool("Read", ["file_path": "/Users/fixture/happy/packages/happy-ios/Sources/HappyLayout/Chat/ChatScreenLayout.swift"], result: "…")
    }

    /// A session long enough that only a window of it is ever laid out.
    static func long(_ b: inout Builder, turns: Int) {
        var random = SeededRandom(seed: 42)
        let prompts = [
            "Why does the list jump when I scroll up?",
            "Rename `ChatRow` to something clearer.",
            "Run the tests again.",
            "What's left before we can ship?",
            "Make the code block scroll horizontally.",
            "Check the dark mode colours against happy-app.",
        ]
        for index in 0..<turns {
            b.user("\(prompts[random.next(prompts.count)]) (#\(index + 1))")
            for _ in 0..<random.next(4) {
                switch random.next(4) {
                case 0: b.tool("Bash", ["command": "swift test --filter Chat\(index)", "description": "Run tests"], result: "ok", description: "Run tests")
                case 1: b.tool("Read", ["file_path": "Sources/HappyUI/Chat/File\(index).swift"], result: "…")
                case 2: b.tool("Grep", ["pattern": "anchor\(index)"], result: "3 matches")
                default: b.tool("Edit", ["file_path": "Sources/HappyUI/Chat/File\(index).swift", "old_string": "a", "new_string": "b"], result: "ok")
                }
            }
            let paragraphs = 1 + random.next(4)
            b.agent((0..<paragraphs).map { paragraph in
                filler[(index + paragraph) % filler.count]
            }.joined(separator: "\n\n"))
        }
    }

    // MARK: Text

    static func reply(to text: String) -> String {
        """
        Got it: "\(text.prefix(80))".

        Here is what I would do next:

        - Reproduce it with the **long** fixture session.
        - Capture the anchor before the update and restore it after.
        - Check that the newest row still follows while it grows.

        ```swift
        let anchor = ChatScrollAnchor.capture(layout: old, ids: ids, visibleMinY: minY)
        ```

        Let me know if you want me to go ahead.
        """
    }

    static let liveAnswer = """
    ## Keyboard handling

    The screen docks its composer to the keyboard and keeps the newest message just above it.

    1. **Frame changes** arrive with the keyboard's own animation curve, so the dock moves *with* the keyboard rather than after it.
    2. **Interactive dismiss** follows the finger: the list's pan drags the keyboard, and the dock tracks the keyboard's top edge every frame.
    3. **Insets** are applied to the list as the keyboard moves, so the last message never hides behind the composer.

    ```swift
    let dock = layout.dock
    composer.frame = dock
    list.contentInset.top = layout.newestEdgeInset
    ```

    | Event | What moves | Animated |
    | --- | --- | --- |
    | Keyboard shows | dock, list inset | yes |
    | Drag to dismiss | dock | follows finger |
    | Rotation | everything | yes |

    That's the whole loop. The tricky part is keeping the reader's row still when they have scrolled up — the anchor handles that.
    """

    static let markdownAnswer = """
    # Keeping the reader's place

    The list is **inverted**: row 0 is the newest message and sits at the bottom of the screen. That one choice removes most of the work.

    ## When the reader is at the bottom

    New content grows *upward* from the composer, so the newest message stays put and everything older slides up. Nothing needs to be corrected.

    ## When the reader has scrolled up

    Before each update the list remembers one row on screen and how far it was from the edge; after the update it scrolls so that row is exactly where it was:

    - capture the anchor row and its distance
      - the row must still exist afterwards
      - if it doesn't, fall back to the nearest survivor
    - apply the new heights
    - restore the distance

    ### Thresholds

    Within `200` points of the newest edge the list *follows* new content. Further up, it holds still. See [the notes](https://github.com/slopus/happy) for details.

    ---

    > This is the same rule Telegram follows, written from scratch.

    That's all there is to it — ~~magic~~ bookkeeping.
    """

    static let codeAnswer = """
    Here it is in TypeScript:

    ```typescript
    function restore(anchor: Anchor, layout: Layout): number {
        if (anchor.kind === 'newest') return 0;
        const frame = layout.frameOf(anchor.id);
        // Keep the row exactly where it was.
        return frame ? frame.minY - anchor.distance : 0;
    }
    ```

    And in Python:

    ```python
    def restore(anchor, layout):
        if anchor.kind == "newest":
            return 0
        frame = layout.frame_of(anchor.id)
        return frame.min_y - anchor.distance if frame else 0
    ```

    | Threshold | Value | Meaning |
    | --- | --- | --- |
    | Follow | 200 pt | Stick to the newest edge |
    | Scroll button | 300 pt | Show "jump to latest" |
    | Dock details hide | 48 pt | Hide the status chrome |
    | Dock details show | 16 pt | Bring it back |

    A one-liner: `layout.rows(from: minY, to: maxY)` returns the visible range.

    ![The anchoring diagram](https://raw.githubusercontent.com/slopus/happy/main/.github/logotype-dark.png)

    ![](https://example.invalid/never-loads.png)
    """

    static let optionsAnswer = """
    Rotation re-lays every row at the new width; the anchor is captured before and restored after, so the reader stays on the same message.

    With the keyboard up the list's newest edge moves with it, and the same anchor keeps the reader's row still.

    Which should I do first?

    <options>
    <option>Write the rotation test</option>
    <option>Write the keyboard test</option>
    <option>Both, rotation first</option>
    </options>
    """

    static let filler = [
        "The anchor is captured before the update and restored after it, so the row you are reading stays exactly where it was.",
        "I re-ran the suite: **all green**. The two flaky tests were measuring before fonts loaded; they now wait for the first layout.",
        "Code blocks scroll horizontally inside their card, so a long line never widens the bubble:\n\n```swift\nlet visible = layout.rows(from: bounds.minY, to: bounds.maxY)\n```",
        "Dark mode now matches happy-app: the bubble uses the account's colour, and tool cards use `surfaceHigh`.",
        "- Renamed `ChatRow` to `ChatRowPlan`\n- Moved measuring off the main thread\n- Cached heights by message id and width",
        "Still left before shipping: the attachment picker, the context meter in the composer, and a pass over VoiceOver order in the inverted list.",
        "That jump came from estimating heights. Every row is now measured before it is shown, so the content size is exact and nothing moves.",
    ]
}

/// Fixture tool inputs as plain literals.
func json(_ value: Any) -> JSONValue {
    switch value {
    case let value as JSONValue: value
    case let value as String: .string(value)
    case let value as Bool: .bool(value)
    case let value as Int: .number(Double(value))
    case let value as Double: .number(value)
    case let value as [Any]: .array(value.map(json))
    case let value as [String: Any]: .object(value.mapValues(json))
    default: .null
    }
}

/// A small deterministic generator, so the long fixture is the same every run.
struct SeededRandom {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    mutating func next(_ bound: Int) -> Int {
        state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        return Int((state >> 33) % UInt64(max(1, bound)))
    }
}
#endif
