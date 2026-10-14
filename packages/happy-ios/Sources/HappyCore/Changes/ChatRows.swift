import Foundation

/// The part of the chat screen's state that its derivation moves on: the
/// rendered window and the work groups. It lives in the derivation's
/// applied state, so it only moves when a result reaches the screen.
public struct ChatWindowState: Equatable, Sendable {
    /// The oldest message rendered; newer messages are always rendered,
    /// older ones join a page at a time as the reader nears them.
    public var oldestRenderedId: String?
    public var windowCount = 0
    public var groups = ChatWorkGroupState()
    /// How many of the screen's requests have been carried out.
    public var grows = 0
    public var toggles = 0
    public var backgrounds = 0

    public init() {}
}

/// What the reader asked the window for, as running tallies the main thread
/// only appends to. The derivation carries out the ones its state has not
/// yet seen, against the messages it is deriving from.
public struct ChatWindowRequests: Equatable, Sendable {
    /// Pages of history asked for.
    public var grows = 0
    /// Work groups opened or closed, by id, in order.
    public var toggles: [String] = []
    /// Times the app went to the background.
    public var backgrounds = 0

    public init() {}
}

/// The rows of a chat window, newest first, and what the screen keeps of
/// them.
public struct ChatWindowItems: Sendable {
    public var items: [ChatListItem]
    public var display: [ChatDisplayItem]
    public var state: ChatWindowState
    /// The rendered window holds every message.
    public var reachesOldest: Bool
}

public enum ChatWindowing {
    /// `messages` oldest first, as a snapshot has them.
    /// `currentTurnComplete`: the agent is neither working nor waiting.
    public static func items(
        _ messages: [ChatMessage],
        state previous: ChatWindowState,
        requests: ChatWindowRequests,
        groupToolCalls: Bool,
        currentTurnComplete: Bool,
        inForeground: Bool
    ) -> ChatWindowItems {
        var state = previous
        let newestFirst = Array(messages.reversed())
        for _ in state.grows..<max(state.grows, requests.grows) {
            guard state.windowCount < newestFirst.count else { break }
            let next = ChatDisplay.windowEnd(newestFirst, desiredEnd: state.windowCount + ChatDisplay.windowPage)
            guard next > state.windowCount else { break }
            state.oldestRenderedId = newestFirst[next - 1].id
            state.windowCount = next
        }
        state.grows = max(state.grows, requests.grows)

        var desiredEnd = max(ChatDisplay.initialWindow, state.windowCount)
        if let oldest = state.oldestRenderedId, let index = newestFirst.firstIndex(where: { $0.id == oldest }) {
            desiredEnd = index + 1
        }
        let end = ChatDisplay.windowEnd(newestFirst, desiredEnd: desiredEnd)
        let window = Array(newestFirst[..<end])
        state.windowCount = end
        // Pin the oldest rendered message, so new messages extend the window
        // rather than push history out from under the reader.
        if state.oldestRenderedId == nil, let last = window.last { state.oldestRenderedId = last.id }

        if requests.backgrounds > state.backgrounds {
            // Coming back to an idle session should not land on a wall of
            // expanded tool calls.
            let before = ChatDisplay.group(window, enabled: groupToolCalls, collapseCurrentTurn: currentTurnComplete)
            state.groups.enterBackground(before)
            state.backgrounds = requests.backgrounds
        }
        state.groups.watch(window, currentTurnComplete: currentTurnComplete, inForeground: inForeground)
        let display = ChatDisplay.group(window, enabled: groupToolCalls, collapseCurrentTurn: currentTurnComplete)
        if requests.toggles.count > state.toggles {
            for id in requests.toggles[state.toggles...] {
                for case .workGroup(let group) in display where group.id == id {
                    state.groups.toggle(group, inForeground: inForeground)
                }
            }
            state.toggles = requests.toggles.count
        }
        let groups = state.groups
        let items = ChatDisplay.listItems(display) { groups.isExpanded($0, inForeground: inForeground) }
        return ChatWindowItems(items: items, display: display, state: state, reachesOldest: end >= newestFirst.count)
    }
}

/// Rows planned at a width: what a list applied, or is about to.
public struct PlannedRows<Input: Equatable & Sendable, Plan: Sendable>: Sendable {
    public var ids: [String]
    public var inputs: [Input]
    public var plans: [Plan]
    public var width: CGFloat
    /// Rows drawn without colour that was still being made.
    public var pending: Set<String>
    /// The colour signals these rows were planned after.
    public var recolour: Int

    public init(ids: [String] = [], inputs: [Input] = [], plans: [Plan] = [], width: CGFloat = 0, pending: Set<String> = [], recolour: Int = 0) {
        self.ids = ids
        self.inputs = inputs
        self.plans = plans
        self.width = width
        self.pending = pending
        self.recolour = recolour
    }
}

/// Plans rows by measuring only what changed: a row is measured once per
/// (id, input, width). It remembers the rows of the latest pass and also
/// reuses the rows a list applied, so a pass that never reached the screen
/// costs nothing later. Used by one derivation at a time.
///
/// A row whose colour was still being made when it was measured
/// (`SyntaxPass.notePending`) is drawn plain and measured again, input
/// unchanged, in the first pass after the next colour signal (`recolour`
/// moves). It changes on screen only once its colour is in: plain to
/// coloured, once.
public final class RowPlanner<Input: Equatable & Sendable, Plan: Sendable>: @unchecked Sendable {
    private struct Entry {
        var input: Input
        var width: CGFloat
        var plan: Plan
        var pending: Bool
        var recolour: Int
    }

    private let lock = NSLock()
    private var cache: [String: Entry] = [:]
    private var measuredTotal = 0
    private let measure: @Sendable (Input, CGFloat) -> Plan

    public init(measure: @escaping @Sendable (Input, CGFloat) -> Plan) {
        self.measure = measure
    }

    /// Rows measured since the planner was made.
    public var measured: Int { lock.withLock { measuredTotal } }

    /// `inputs` planned at `width`, and what changed against `applied`.
    /// `measured` counts the rows measured for this pass. `recolour` counts
    /// the colour signals heard so far.
    public func plan(
        _ inputs: [Input],
        id: (Input) -> String,
        width: CGFloat,
        applied: PlannedRows<Input, Plan>,
        recolour: Int = 0
    ) -> (rows: PlannedRows<Input, Plan>, changeset: RowChangeset, measured: Int) {
        lock.lock()
        defer { lock.unlock() }
        var appliedIndex: [String: Int] = [:]
        if applied.width == width {
            appliedIndex.reserveCapacity(applied.ids.count)
            for (index, id) in applied.ids.enumerated() where appliedIndex[id] == nil {
                appliedIndex[id] = index
            }
        }
        var next: [String: Entry] = [:]
        next.reserveCapacity(inputs.count)
        var ids: [String] = []
        ids.reserveCapacity(inputs.count)
        var plans: [Plan] = []
        plans.reserveCapacity(inputs.count)
        var pending = Set<String>()
        var measured = 0
        for input in inputs {
            let key = id(input)
            ids.append(key)
            var entry: Entry
            if let cached = cache[key] ?? next[key], cached.width == width, cached.input == input {
                entry = cached
            } else if let index = appliedIndex[key], applied.inputs[index] == input {
                entry = Entry(input: input, width: width, plan: applied.plans[index],
                              pending: applied.pending.contains(key), recolour: applied.recolour)
            } else {
                entry = measure(input, width: width, recolour: recolour)
                measured += 1
            }
            if entry.pending && entry.recolour < recolour {
                entry = measure(input, width: width, recolour: recolour)
                measured += 1
            }
            next[key] = entry
            plans.append(entry.plan)
            if entry.pending { pending.insert(key) }
        }
        cache = next
        measuredTotal += measured
        let rows = PlannedRows(ids: ids, inputs: inputs, plans: plans, width: width, pending: pending, recolour: recolour)
        let sameWidth = applied.width == width
        // A row whose colour came in changes; one still waiting does not.
        let changeset = RowChangeset(oldIds: applied.ids, newIds: ids) { old, new in
            !sameWidth || applied.inputs[old] != inputs[new]
                || (applied.pending.contains(applied.ids[old]) && !pending.contains(ids[new]))
        }
        return (rows, changeset, measured)
    }

    private func measure(_ input: Input, width: CGFloat, recolour: Int) -> Entry {
        let (plan, pending) = SyntaxPass.measuring { measure(input, width) }
        return Entry(input: input, width: width, plan: plan, pending: pending, recolour: recolour)
    }
}

/// What the chat screen reads from a snapshot besides its rows: the
/// placeholder, the composer and the questions a sent message answers.
/// Worked out with the rows, so the main thread never scans the messages.
public struct ChatSnapshotFacts: Equatable, Sendable {
    public var isLoaded: Bool
    public var isEmpty: Bool
    public var hasMoreOlder: Bool
    public var olderBoundary: Int?
    public var windowEpoch: Int
    public var usage: ChatUsage?
    public var delivery: [String: OutboxDelivery]
    /// The agent waits on a question the person can answer by typing.
    public var hasPendingQuestion: Bool
    /// Local ids of the user messages the server has stored.
    public var storedLocalIds: Set<String>

    public init(_ snapshot: ChatSnapshot) {
        isLoaded = snapshot.isLoaded
        isEmpty = snapshot.messages.isEmpty
        hasMoreOlder = snapshot.hasMoreOlder
        olderBoundary = snapshot.olderBoundary
        windowEpoch = snapshot.windowEpoch
        usage = snapshot.usage
        delivery = snapshot.delivery
        var pendingQuestion = false
        var stored = Set<String>()
        for message in snapshot.messages {
            switch message {
            case .toolCall(let call):
                if !pendingQuestion, ChatToolDisplay.isInteractiveQuestion(call.tool.name), call.tool.state == .running {
                    pendingQuestion = true
                }
            case .userText(let user):
                if let localId = user.localId { stored.insert(localId) }
            default:
                break
            }
        }
        hasPendingQuestion = pendingQuestion
        storedLocalIds = stored
    }
}

/// The chat's rows from a snapshot, off the main thread: the window, the
/// display items, one row input each (`makeRows`, the screen's own), then
/// a plan per row measured only when its input or the width changed, and
/// the changeset against the rows the list applied last. The rows measured
/// in one pass share one syntax deadline (`SyntaxPass`).
public enum ChatRowsDerivation {
    public struct Result<Row: Equatable & Sendable, Plan: Sendable>: Sendable {
        public var window: ChatWindowItems
        public var rows: PlannedRows<Row, Plan>
        public var changeset: RowChangeset
        /// Rows measured for this result.
        public var measured: Int
    }

    public static func derive<Row: Equatable & Sendable, Plan: Sendable>(
        messages: [ChatMessage],
        window: ChatWindowState,
        requests: ChatWindowRequests,
        groupToolCalls: Bool,
        currentTurnComplete: Bool,
        inForeground: Bool,
        width: CGFloat,
        planner: RowPlanner<Row, Plan>,
        applied: PlannedRows<Row, Plan>,
        makeRows: (_ items: [ChatListItem], _ groups: ChatWorkGroupState) -> [Row],
        id: (Row) -> String,
        syntaxDeadline: ContinuousClock.Instant? = nil,
        recolour: Int = 0
    ) -> Result<Row, Plan> {
        let syntaxDeadline = syntaxDeadline ?? SyntaxPass.deadline()
        let items = ChatWindowing.items(
            messages, state: window, requests: requests, groupToolCalls: groupToolCalls,
            currentTurnComplete: currentTurnComplete, inForeground: inForeground
        )
        let rows = makeRows(items.items, items.state.groups)
        let planned = SyntaxPass.run(until: syntaxDeadline) {
            planner.plan(rows, id: id, width: width, applied: applied, recolour: recolour)
        }
        return Result(window: items, rows: planned.rows, changeset: planned.changeset, measured: planned.measured)
    }
}
