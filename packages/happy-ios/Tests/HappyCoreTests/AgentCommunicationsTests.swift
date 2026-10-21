import XCTest
import HappyWire
@testable import HappyCore

// Expected values follow happy-app's agentCommunications.ts,
// InlineQuestionForm.tsx, AskUserQuestionView.tsx and RequestUserInputView.tsx.

private let choice: JSONValue = [
    "id": "q1", "header": "Scope", "question": "Which part?",
    "options": [["label": "List"], ["label": "Composer", "description": "The input"]],
]
private let written: JSONValue = ["id": "q2", "header": "Name", "question": "What should it be called?"]
private let closedText: JSONValue = ["id": "q3", "header": "Empty", "question": "Nothing to answer", "allowCustom": .bool(false)]

final class AgentCommunicationsTests: XCTestCase {
    func testPendingCommunicationsOldestFirstWithUnknownKindsKept() {
        let state: JSONValue = [
            "communications": [
                "b": ["kind": "form", "createdAt": 20, "toolUseId": "call-b", "form": ["questions": [choice]]],
                "a": ["kind": "approval", "createdAt": 10, "title": "Approve deploy"],
                "c": ["kind": "form", "createdAt": 5, "form": ["questions": [closedText]]],
                "d": ["kind": "form", "createdAt": 1, "form": ["questions": [written]]],
            ],
            "completedCommunications": ["d": ["kind": "form", "status": "answered", "form": ["questions": [written]]]],
        ]
        let pending = AgentCommunications.pending(state)
        XCTAssertEqual(pending.map(\.id), ["a", "b"])
        XCTAssertEqual(pending[0].kind, .unsupported(rawKind: "approval", title: "Approve deploy"))
        XCTAssertEqual(pending[1].toolUseId, "call-b")
        XCTAssertEqual(pending[1].questions.map(\.options.count), [2])
        XCTAssertTrue(AgentCommunications.canRenderInline(pending[1]))
        XCTAssertTrue(AgentCommunications.usesFallback(pending[0]))
        let textOnly = PendingAgentCommunication(id: "x", createdAt: 0, kind: .form([AgentQuestion(json: written)!]))
        XCTAssertTrue(AgentCommunications.usesFallback(textOnly))
        XCTAssertEqual(AgentCommunications.pending(nil), [])
    }

    func testTheFormForAToolCallPrefersItsAnswer() {
        let state: JSONValue = [
            "communications": ["r1": ["kind": "form", "toolUseId": "call-1", "form": ["questions": [choice]]]],
            "completedCommunications": ["r1": [
                "kind": "form", "toolUseId": "call-1", "status": "answered", "form": ["questions": [choice]],
                "answers": ["q1": ["options": ["List"], "custom": "and the header"]],
            ]],
        ]
        let form = AgentCommunications.form(state, toolUseId: "call-1")
        XCTAssertEqual(form?.status, .answered)
        XCTAssertEqual(form?.answers?["q1"], AgentQuestionAnswer(options: ["List"], custom: "and the header"))
        let pendingState: JSONValue = ["communications": ["r2": ["kind": "form", "form": ["questions": [choice]]]]]
        // Without a toolUseId the request id is the join key.
        XCTAssertEqual(AgentCommunications.form(pendingState, toolUseId: "r2")?.status, .pending)
        XCTAssertNil(AgentCommunications.form(pendingState, toolUseId: "other"))
    }

    func testDraftsAndAnswers() {
        let multi = AgentQuestion(id: "m", header: "H", question: "Q", options: [.init(label: "a"), .init(label: "b")], multiSelect: true)
        let single = AgentQuestion(id: "s", header: "H", question: "Q", options: [.init(label: "x"), .init(label: "y")])
        let optional = AgentQuestion(id: "o", header: "H", question: "Q", options: [], required: false)
        var draft = AgentCommunications.toggleOption(AgentQuestionDraft(), label: "x", multiSelect: false)
        draft = AgentCommunications.toggleOption(draft, label: "y", multiSelect: false)
        XCTAssertEqual(draft.options, ["y"])
        XCTAssertEqual(AgentCommunications.toggleOption(draft, label: "y", multiSelect: false).options, [])
        var many = AgentCommunications.toggleOption(AgentQuestionDraft(), label: "b", multiSelect: true)
        many = AgentCommunications.toggleOption(many, label: "a", multiSelect: true)
        XCTAssertEqual(many.options, ["b", "a"])
        let drafts = ["m": many, "s": AgentQuestionDraft(options: ["x", "y"], custom: "  "), "o": AgentQuestionDraft(custom: " own ")]
        XCTAssertTrue(AgentCommunications.canSubmit([multi, single, optional], drafts: drafts))
        XCTAssertFalse(AgentCommunications.canSubmit([single], drafts: ["s": AgentQuestionDraft(custom: " ")]))
        let answers = AgentCommunications.buildAnswers([multi, single, optional], drafts: drafts)
        XCTAssertEqual(answers["m"], AgentQuestionAnswer(options: ["b", "a"]))
        XCTAssertEqual(answers["s"], AgentQuestionAnswer(options: ["x"]))
        XCTAssertEqual(answers["o"], AgentQuestionAnswer(options: [], custom: "own"))
        XCTAssertEqual(AgentCommunications.json(["o": answers["o"]!]), ["o": ["options": [], "custom": "own"]])
        XCTAssertEqual(AgentCommunications.describe(answers["o"]), "own")
        XCTAssertEqual(AgentCommunications.describe(nil), "—")
    }
}

final class InlineQuestionFormTests: XCTestCase {
    private let input: JSONValue = ["questions": [
        ["header": "Scope", "question": "Which part?", "options": [["label": "List"], ["label": "Composer"]]],
        ["header": "Extras", "question": "Anything else?", "multiSelect": .bool(true), "options": [["label": "Tests"], ["label": "Docs"]]],
    ]]

    private func ask(_ state: ToolCall.State) -> ToolCall {
        ToolCall(name: "AskUserQuestion", state: state, input: input, createdAt: 0, permission: ToolPermission(id: "perm-q", status: state == .running ? .pending : .approved))
    }

    func testAskUserQuestionAnswersThroughItsPermission() throws {
        let form = try XCTUnwrap(InlineQuestionForm.askUserQuestion(ask(.running)))
        XCTAssertEqual(form.questions.map(\.id), ["question-0", "question-1"])
        XCTAssertTrue(form.canInteract)
        XCTAssertNil(form.submitted)
        XCTAssertEqual(form.reply, .permission(id: "perm-q"))

        var selections = InlineQuestionSelections()
        XCTAssertFalse(selections.allAnswered(form.questions))
        selections.toggle(form.questions[0], option: 1)
        selections.toggle(form.questions[0], option: 1)
        selections.toggle(form.questions[1], option: 1)
        selections.toggle(form.questions[1], option: 0)
        XCTAssertTrue(selections.isSelected(form.questions[0], option: 1))
        XCTAssertTrue(selections.allAnswered(form.questions))
        let answers = selections.answers(form.questions)
        XCTAssertEqual(answers, ["question-0": ["Composer"], "question-1": ["Docs", "Tests"]])
        XCTAssertEqual(InlineQuestionForm.askUserQuestionInput(ask(.running), answers: answers), ["answers": [
            "Which part?": "Composer", "Anything else?": "Docs, Tests",
        ]])

        XCTAssertEqual(InlineQuestionForm.askUserQuestion(ask(.completed))?.submitted, [:])
        let failed = InlineQuestionForm.askUserQuestion(ask(.error))
        XCTAssertEqual(failed?.canInteract, false)
        XCTAssertNil(failed?.submitted)
        XCTAssertNil(InlineQuestionForm.askUserQuestion(ToolCall(name: "AskUserQuestion", state: .running, input: [:], createdAt: 0)))
    }

    func testRequestUserInputAnswersTheCommunication() throws {
        let tool = ToolCall(callId: "call-1", name: "request_user_input", state: .running, input: [:], createdAt: 0)
        let questions = [AgentQuestion(json: choice)!]
        let pending = AgentFormCommunication(id: "r1", toolUseId: "call-1", questions: questions, status: .pending, answers: nil)
        let form = try XCTUnwrap(InlineQuestionForm.requestUserInput(tool, communication: pending))
        XCTAssertTrue(form.canInteract)
        XCTAssertEqual(form.reply, .communication(id: "r1", kind: "form"))
        XCTAssertEqual(InlineQuestionForm.communicationAnswers(form.questions, answers: ["q1": ["List", "Composer"]]), ["q1": ["options": ["List"]]])

        let answered = AgentFormCommunication(id: "r1", questions: questions, status: .answered, answers: ["q1": AgentQuestionAnswer(options: ["List"], custom: "also docs")])
        XCTAssertEqual(InlineQuestionForm.requestUserInput(tool, communication: answered)?.submitted, ["q1": ["List", "also docs"]])
        XCTAssertEqual(InlineQuestionForm.requestUserInput(tool, communication: answered)?.canInteract, false)
        let cancelled = AgentFormCommunication(id: "r1", questions: questions, status: .cancelled, answers: nil)
        XCTAssertEqual(InlineQuestionForm.requestUserInput(tool, communication: cancelled)?.submitted, [:])
        // A written-answer question is the banner's.
        let textOnly = AgentFormCommunication(id: "r1", questions: [AgentQuestion(json: written)!], status: .pending, answers: nil)
        XCTAssertNil(InlineQuestionForm.requestUserInput(tool, communication: textOnly))
        XCTAssertNil(InlineQuestionForm.requestUserInput(tool, communication: nil))
    }
}
