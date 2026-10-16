#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// What the chat screen decides on the main thread and hands to the rows'
/// derivation: the list's width and layout, and what the reader opened,
/// picked or is waiting on. All of it is small, and copied whole.
struct ChatRowsView: Equatable, Sendable {
    var width: CGFloat = 0
    var maxContentWidth: CGFloat = .greatestFiniteMagnitude
    var tablet = false
    /// The list's text size and the screen's words: every row is planned
    /// in them.
    var text = ChatRowText.designed
    var permissionListMaxHeight = PermissionFooterLayout.Metrics.maxListHeight
    var inForeground = true
    var permissionBusy: [String: PermissionButton.Kind] = [:]
    var expandedTools: Set<String> = []
    var diffExpanded: [String: [Int: Set<Int>]] = [:]
    var copiedMessageId: String?
    var questionDrafts: [String: ChatQuestionState] = [:]
    var requests = ChatWindowRequests()
    /// The row the reader just opened or closed, held still by the update
    /// that shows it. `pins` counts them, so each is used once.
    var pin: String?
    var pins = 0
    /// Moves when a waiting message's quiet spell ends, so its status shows.
    var tick = 0
    /// The heights diagrams' pages reported, by row id, then by the
    /// diagram's place in the row.
    var mermaidHeights: [String: [Int: CGFloat]] = [:]
}

struct ChatRowsInput: Sendable {
    var snapshot: ChatSnapshot?
    var session: ChatSessionState
    var view = ChatRowsView()
    /// The account's diff documents and syntax colour.
    var render: RenderServices
    /// Colour signals heard: rows drawn while their code blocks were still
    /// being coloured are planned again after one.
    var recolour = 0

    init(snapshot: ChatSnapshot? = nil, session: ChatSessionState, view: ChatRowsView = ChatRowsView(), render: RenderServices) {
        self.snapshot = snapshot
        self.session = session
        self.view = view
        self.render = render
    }
}

/// A question form in the chat, as the latest rows have it.
struct ChatQuestionForm: Equatable, Sendable {
    var tool: ToolCall
    var form: InlineQuestionForm
}

/// What the chat screen shows now: the derivation's applied state.
struct ChatRowsApplied: Sendable {
    struct Footer: Sendable {
        var controlledByUser: Bool
        var width: CGFloat
        var text: TextEnvironment?
        var plan: ChatRowPlan
    }

    var window = ChatWindowState()
    var rows = PlannedRows<ChatRowInput, ChatRowPlan>()
    var model = ChatListLayout(width: 0, heights: [])
    var footer: Footer?
    var facts: ChatSnapshotFacts?
    var questionForms: [String: ChatQuestionForm] = [:]
    var graceEnd: Int64?
    var pins = 0
    var ticks = 0
}

/// The rows and their geometry, planned off the main thread, with their
/// changes against what the list shows.
struct ChatListUpdate: Sendable {
    var ids: [String]
    var plans: [ChatRowPlan]
    var model: ChatListLayout
    /// Nil keeps the footer the list has.
    var footer: ChatRowPlan?
    var changeset: RowChangeset
    var pinning: String?
}

/// One chat update for the main thread. Every optional is nil when its
/// part of the screen keeps what it shows.
struct ChatRowsUpdate: Sendable {
    /// What the list was planned for; another width, layout or text size
    /// is refused.
    var width: CGFloat
    var tablet: Bool
    var text: TextEnvironment?
    var list: ChatListUpdate?
    var facts: ChatSnapshotFacts?
    var questionForms: [String: ChatQuestionForm]?
    var graceEnd: Int64?
    var now: Int64
    /// Pages of history the rendered window has taken in.
    var grows: Int
    var reachesOldest: Bool
    /// `ChatOlderPaging.boundary` of the rendered rows.
    var oldestBoundary: String?
    /// Rows measured for this update.
    var measured: Int
}

/// The chat's rows from a snapshot, off the main thread: the window, one
/// input per row, a plan per row measured only when its input or the width
/// changed, the footer and the list's geometry. Nil when the screen
/// already shows exactly this.
enum ChatRows {
    static func derive(
        _ input: ChatRowsInput,
        applied: ChatRowsApplied,
        planner: RowPlanner<ChatRowInput, ChatRowPlan>
    ) -> (output: ChatRowsUpdate, state: ChatRowsApplied)? {
        guard let snapshot = input.snapshot else { return nil }
        let view = input.view
        let session = input.session
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var state = applied
        var update = ChatRowsUpdate(
            width: view.width, tablet: view.tablet, text: view.text.environment, graceEnd: applied.graceEnd, now: now,
            grows: applied.window.grows, reachesOldest: false, measured: 0
        )
        // A grace tick always answers, so the screen sets its next timer
        // even when no status moved yet.
        var changed = view.tick != applied.ticks
        state.ticks = view.tick

        let facts = ChatSnapshotFacts(snapshot)
        if facts != applied.facts {
            if let before = applied.facts, before.windowEpoch != facts.windowEpoch {
                // The covered window dropped rows it showed: it starts again
                // from the newest page, and growth asked for before is
                // dropped (History W3).
                state.window.oldestRenderedId = nil
                state.window.windowCount = 0
                state.window.grows = view.requests.grows
                update.grows = state.window.grows
            }
            update.facts = facts
            state.facts = facts
            changed = true
        }
        guard view.width > 0 else { return changed ? (update, state) : nil }

        let flavor = session.flavor
        let style = ChatRowStyle(
            bubble: session.settings.userMessageBubbleColor,
            compactTools: session.compactToolCalls,
            claudeFlavor: flavor == nil || flavor == "" || flavor == "claude",
            maxContentWidth: view.maxContentWidth,
            root: session.metadata?["path"]?.stringValue,
            flavor: flavor,
            showLineNumbers: session.settings.bool("showLineNumbersInToolViews"),
            tablet: view.tablet,
            permissionListMaxHeight: view.permissionListMaxHeight,
            text: view.text,
            render: input.render
        )
        var graceEnd: Int64?
        var forms: [String: ChatQuestionForm] = [:]
        let result = ChatRowsDerivation.derive(
            messages: snapshot.messages,
            window: state.window,
            requests: view.requests,
            groupToolCalls: session.groupToolCalls,
            currentTurnComplete: !session.thinking && !session.hasPendingPermission,
            inForeground: view.inForeground,
            width: view.width,
            planner: planner,
            applied: applied.rows,
            makeRows: { items, groups in
                rows(items, groups: groups, delivery: snapshot.delivery, agentState: session.agentState, view: view, style: style, now: now, graceEnd: &graceEnd, forms: &forms)
            },
            id: \.id,
            recolour: input.recolour
        )
        update.measured = result.measured
        update.grows = result.window.state.grows
        update.reachesOldest = result.window.reachesOldest
        update.oldestBoundary = ChatOlderPaging.boundary(result.window.items)
        if result.window.state != applied.window {
            changed = true
        }
        state.window = result.window.state
        if forms != applied.questionForms {
            update.questionForms = forms
            state.questionForms = forms
            changed = true
        }
        if graceEnd != applied.graceEnd {
            update.graceEnd = graceEnd
            state.graceEnd = graceEnd
            changed = true
        }

        var footer: ChatRowPlan?
        let footerPlan: ChatRowPlan
        let environment = view.text.environment
        if let cached = applied.footer, cached.controlledByUser == session.controlledByUser, cached.width == view.width, cached.text == environment {
            footerPlan = cached.plan
        } else {
            footerPlan = ChatRowRenderer.footer(controlledByUser: session.controlledByUser, width: view.width, in: environment)
            footer = footerPlan
            state.footer = ChatRowsApplied.Footer(controlledByUser: session.controlledByUser, width: view.width, text: environment, plan: footerPlan)
        }
        let model = ChatListLayout(
            width: view.width,
            heights: result.rows.plans.map { $0.size.height },
            newerEndHeight: footerPlan.size.height,
            olderEndHeight: ChatOlderEndLayout.height
        )
        let pinning = view.pins > applied.pins ? view.pin : nil
        state.pins = view.pins
        if !result.changeset.isEmpty || footer != nil || model != applied.model || pinning != nil {
            update.list = ChatListUpdate(
                ids: result.rows.ids, plans: result.rows.plans, model: model, footer: footer,
                changeset: result.changeset, pinning: pinning
            )
            state.rows = result.rows
            state.model = model
            changed = true
        }
        return changed ? (update, state) : nil
    }

    /// One input per shown row, newest first. Collects the question forms
    /// in the window and the next time a waiting message's status is due.
    static func rows(
        _ items: [ChatListItem],
        groups: ChatWorkGroupState,
        delivery deliveries: [String: OutboxDelivery],
        agentState: JSONValue?,
        view: ChatRowsView,
        style: ChatRowStyle,
        now: Int64,
        graceEnd: inout Int64?,
        forms: inout [String: ChatQuestionForm]
    ) -> [ChatRowInput] {
        items.filter { ChatRowRenderer.isShown($0, style: style) }.map { item in
            var delivery: OutboxDelivery?
            var userStatus: UserMessageStatus?
            if case .message(.userText(let message)) = item {
                if let localId = message.localId { delivery = deliveries[localId] }
                userStatus = ChatRowRenderer.userStatus(message, delivery: delivery, now: now)
                if let end = UserMessageStatus.graceEnds(
                    pending: message.pending, undelivered: delivery != nil, queuedWhileBusy: message.meta?.queuedWhileBusy == true,
                    createdAt: message.createdAt, now: now
                ) {
                    graceEnd = min(graceEnd ?? end, end)
                }
            }
            var copied = false
            if case .message(.agentText(let message)) = item { copied = message.id == view.copiedMessageId }
            var expanded = false
            if case .workHeader(let group, _) = item {
                expanded = groups.isExpanded(group, inForeground: view.inForeground)
            }
            var busy: PermissionButton.Kind?
            var question: ChatQuestionState?
            var diffs: [Int: Set<Int>] = [:]
            if case .message(.toolCall(let call)) = item {
                diffs = view.diffExpanded[call.id] ?? [:]
                expanded = view.expandedTools.contains(call.id)
                busy = call.tool.permission.flatMap { view.permissionBusy[$0.id] }
                if let form = questionForm(call.tool, agentState: agentState) {
                    forms[call.id] = ChatQuestionForm(tool: call.tool, form: form)
                    var state = view.questionDrafts[call.id] ?? ChatQuestionState(form: form)
                    state.form = form
                    question = state
                }
            }
            return ChatRowInput(
                item: item, delivery: delivery, expanded: expanded, permissionBusy: busy, question: question, diffExpanded: diffs,
                userStatus: userStatus, copied: copied, mermaid: view.mermaidHeights[item.id] ?? [:], style: style
            )
        }
    }

    /// AskUserQuestion answers through its permission; request_user_input
    /// through the communication it raised.
    static func questionForm(_ tool: ToolCall, agentState: JSONValue?) -> InlineQuestionForm? {
        switch tool.name {
        case "AskUserQuestion": InlineQuestionForm.askUserQuestion(tool)
        case "request_user_input": InlineQuestionForm.requestUserInput(tool, communication: AgentCommunications.form(agentState, toolUseId: tool.callId))
        default: nil
        }
    }
}
#endif
