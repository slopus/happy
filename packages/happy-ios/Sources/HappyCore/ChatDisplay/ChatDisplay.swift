import Foundation

// What the chat list shows, decided before anything is measured: which
// messages are invisible, how a finished turn folds its work away, and the
// flat row list an expanded group turns into. A port of happy-app's
// `utils/agentTurns.ts`, `hooks/useGroupedMessages.ts` and the list-building
// half of `components/ChatList.tsx`.
//
// happy-app works on messages newest-first, as sync stores them; so does
// everything here. `ChatSnapshot.messages` is oldest-first: reverse it once.

/// A finished turn's intermediate work, folded into one "Worked for …" row
/// above the turn's final answer (`AgentWorkGroupItem`).
public struct ChatWorkGroup: Equatable, Sendable {
    /// `work-<final answer id>`: the one member a turn is sure to have, so
    /// the group keeps its identity while older pages arrive.
    public var id: String
    /// The settled prompt that opened the turn, when it is loaded.
    public var turnUserMessageId: String?
    /// The folded messages in the order they are drawn (oldest first).
    public var messages: [ChatMessage]
    public var hasRunning: Bool
    public var hasPendingPermission: Bool
    public var startedAt: Int64
    public var completedAt: Int64?

    public init(id: String, turnUserMessageId: String?, messages: [ChatMessage], hasRunning: Bool = false, hasPendingPermission: Bool = false, startedAt: Int64, completedAt: Int64?) {
        self.id = id
        self.turnUserMessageId = turnUserMessageId
        self.messages = messages
        self.hasRunning = hasRunning
        self.hasPendingPermission = hasPendingPermission
        self.startedAt = startedAt
        self.completedAt = completedAt
    }
}

/// A message or a folded group, in reading order (`DisplayItem`).
public enum ChatDisplayItem: Equatable, Sendable {
    case message(ChatMessage)
    case workGroup(ChatWorkGroup)

    public var id: String {
        switch self {
        case .message(let message): message.id
        case .workGroup(let group): group.id
        }
    }
}

/// One row of the list. The list is flat: an expanded group's members are
/// ordinary rows after its header, so expanding is a plain data change.
public enum ChatListItem: Equatable, Sendable {
    public enum Placement: Equatable, Sendable {
        /// Above the group's members, where the folded group sits.
        case leading
        /// Below an expanded group's members, so "Hide" lands under the
        /// reader's thumb after the members push the leading copy away.
        case trailing
    }

    case message(ChatMessage)
    case workHeader(ChatWorkGroup, placement: Placement)

    public var id: String {
        switch self {
        case .message(let message): message.id
        case .workHeader(let group, .leading): group.id
        case .workHeader(let group, .trailing): "\(group.id):collapse"
        }
    }
}

public enum ChatDisplay {
    /// Messages the list renders before the reader scrolls back
    /// (`INITIAL_WINDOW`), and how many more each step back adds
    /// (`WINDOW_PAGE`).
    public static let initialWindow = 60
    public static let windowPage = 60

    /// The turn of each message (newest first); turn 0 is the latest.
    ///
    /// A turn ends at a settled user message. It also ends where two agent
    /// rows carry different turn ids, because those are different answers
    /// even when the prompt between them never reached this device. Rows
    /// without a turn id never start a turn on their own.
    public static func assignTurns(_ messages: [ChatMessage]) -> [Int] {
        var turnOf = [Int](repeating: 0, count: messages.count)
        var turn = 0
        var turnId: String?
        for (index, message) in messages.enumerated() {
            if !message.isUserText, let id = message.turn {
                if let current = turnId, current != id { turn += 1 }
                turnId = id
            }
            turnOf[index] = turn
            if message.isSettledUserText {
                turn += 1
                // The next (older) agent row belongs to the turn before this
                // prompt; its id must not be compared with the one just left.
                turnId = nil
            }
        }
        return turnOf
    }

    /// Display items in reading order (oldest first) from messages newest
    /// first. With grouping off every visible message passes through.
    /// `collapseCurrentTurn` is false while the latest turn is still running,
    /// so its work stays flat until the answer is final.
    public static func group(_ messages: [ChatMessage], enabled: Bool, collapseCurrentTurn: Bool = true) -> [ChatDisplayItem] {
        guard enabled else {
            return messages.reversed().filter { !isInvisible($0) }.map(ChatDisplayItem.message)
        }
        let turnOf = assignTurns(messages)
        var hidden = Set<Int>()
        var groupAtOldest: [Int: ChatWorkGroup] = [:]
        for group in workGroups(messages, turnOf: turnOf, collapseCurrentTurn: collapseCurrentTurn) {
            groupAtOldest[group.oldest] = group.item
            hidden.formUnion(group.hidden)
        }
        // Newest first, like the input, then reversed once. A group is
        // emitted at its oldest member, so the order reads prompt, folded
        // work, final answer.
        var result: [ChatDisplayItem] = []
        for (index, message) in messages.enumerated() where !isInvisible(message) {
            if hidden.contains(index) {
                if let group = groupAtOldest[index] { result.append(.workGroup(group)) }
                continue
            }
            result.append(.message(message))
        }
        return result.reversed()
    }

    private static func workGroups(_ messages: [ChatMessage], turnOf: [Int], collapseCurrentTurn: Bool) -> [(item: ChatWorkGroup, hidden: [Int], oldest: Int)] {
        // Turns in the order they are first seen, newest first, like a JS Map.
        var order: [Int] = []
        var segments: [Int: [Int]] = [:]
        for index in messages.indices {
            let turn = turnOf[index]
            if segments[turn] == nil { order.append(turn) }
            segments[turn, default: []].append(index)
        }

        var groups: [(item: ChatWorkGroup, hidden: [Int], oldest: Int)] = []
        for turn in order {
            if turn == 0 && !collapseCurrentTurn { continue }
            let indexes = segments[turn] ?? []
            let visibleAgent = indexes.filter { index in
                let message = messages[index]
                if message.isUserText || isInvisible(message) || isUserAttachment(message) { return false }
                if case .toolCall(let call) = message, ChatToolDisplay.isInteractiveQuestion(call.tool.name) { return false }
                return true
            }
            guard let finalText = visibleAgent.first(where: { messages[$0].isAgentText }) else { continue }
            let hiddenIndexes = visibleAgent.filter { $0 > finalText }
            guard let oldest = hiddenIndexes.max() else { continue }
            let hiddenMessages = hiddenIndexes.map { messages[$0] }
            let prompt = indexes.map { messages[$0] }.first(where: \.isSettledUserText)
            groups.append((
                item: ChatWorkGroup(
                    id: "work-\(messages[finalText].id)",
                    turnUserMessageId: prompt?.id,
                    messages: hiddenMessages.reversed(),
                    hasRunning: false,
                    hasPendingPermission: hiddenMessages.contains(where: \.hasPendingPermission),
                    startedAt: hiddenMessages.map(\.createdAt).min() ?? 0,
                    completedAt: messages[finalText].createdAt
                ),
                hidden: hiddenIndexes,
                oldest: oldest
            ))
        }
        return groups
    }

    /// The list's rows, newest first (index 0 is the newest row): each group
    /// becomes its header, and an expanded group adds its members and a
    /// trailing header below them in reading order.
    public static func listItems(_ items: [ChatDisplayItem], isExpanded: (ChatWorkGroup) -> Bool) -> [ChatListItem] {
        var out: [ChatListItem] = []
        out.reserveCapacity(items.count)
        for item in items {
            switch item {
            case .message(let message):
                out.append(.message(message))
            case .workGroup(let group):
                out.append(.workHeader(group, placement: .leading))
                if isExpanded(group) {
                    out.append(contentsOf: group.messages.map(ChatListItem.message))
                    out.append(.workHeader(group, placement: .trailing))
                }
            }
        }
        return out.reversed()
    }

    /// How many messages (newest first) a window of `desiredEnd` renders:
    /// extended to the settled prompt that opened the oldest turn, so a
    /// turn's folded work stays whole (`windowEndForTurn`).
    public static func windowEnd(_ messages: [ChatMessage], desiredEnd: Int) -> Int {
        var end = min(max(0, desiredEnd), messages.count)
        while end > 0 && end < messages.count {
            if messages[end - 1].isSettledUserText { break }
            end += 1
        }
        return end
    }

    /// Renders as nothing and is left out entirely: hidden tools, thinking,
    /// and agent text that is only whitespace.
    public static func isInvisible(_ message: ChatMessage) -> Bool {
        switch message {
        case .toolCall(let call):
            return ChatToolDisplay.isHidden(call.tool.name)
        case .agentText(let text):
            return text.isThinking || text.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        default:
            return false
        }
    }

    /// A picture or file the person sent: never folded into a group.
    public static func isUserAttachment(_ message: ChatMessage) -> Bool {
        if case .toolCall(let call) = message { return call.tool.name == "file" }
        return false
    }

    /// "2m3s": hours and minutes, minutes and seconds, or seconds.
    public static func formatWorkDuration(milliseconds: Int64) -> String {
        let total = max(0, milliseconds / 1000)
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let seconds = total % 60
        if hours > 0 { return "\(hours)h\(minutes)m" }
        if minutes > 0 { return "\(minutes)m\(seconds)s" }
        return "\(seconds)s"
    }
}

/// Which work groups are open: the ones the reader opened, the ones they
/// closed on purpose, and the turns they watched run. A watched turn stays
/// open when it finishes; completed history first seen on open stays folded.
public struct ChatWorkGroupState: Equatable, Sendable {
    public private(set) var expanded: Set<String> = []
    /// Suppresses the automatic opening below.
    public private(set) var closed: Set<String> = []
    /// Prompts whose turn was seen in progress.
    public private(set) var watchedTurns: Set<String> = []

    public init() {}

    public func isExpanded(_ group: ChatWorkGroup, inForeground: Bool) -> Bool {
        if expanded.contains(group.id) { return true }
        if closed.contains(group.id) { return false }
        if let prompt = group.turnUserMessageId, inForeground, watchedTurns.contains(prompt) { return true }
        return group.hasPendingPermission || group.hasRunning
    }

    public mutating func toggle(_ group: ChatWorkGroup, inForeground: Bool) {
        if isExpanded(group, inForeground: inForeground) {
            expanded.remove(group.id)
            closed.insert(group.id)
        } else {
            expanded.insert(group.id)
            closed.remove(group.id)
        }
    }

    /// Records the turn in progress and forgets prompts no longer rendered.
    /// `messages` is the rendered window, newest first. Returns whether
    /// anything changed.
    @discardableResult
    public mutating func watch(_ messages: [ChatMessage], currentTurnComplete: Bool, inForeground: Bool) -> Bool {
        var next = Set<String>()
        if inForeground {
            let shown = Set(messages.lazy.filter(\.isUserText).map(\.id))
            next = watchedTurns.intersection(shown)
            if !currentTurnComplete, let current = messages.first(where: \.isSettledUserText) {
                next.insert(current.id)
            }
        }
        guard next != watchedTurns else { return false }
        watchedTurns = next
        return true
    }

    /// Going to the background folds everything that has finished, so coming
    /// back to an idle session does not land on a wall of tool calls.
    public mutating func enterBackground(_ items: [ChatDisplayItem]) {
        watchedTurns = []
        var running = Set<String>()
        for case .workGroup(let group) in items where group.hasRunning && expanded.contains(group.id) {
            running.insert(group.id)
        }
        expanded = running
        closed = []
    }
}

extension ChatMessage {
    public var isUserText: Bool {
        if case .userText = self { return true }
        return false
    }

    public var isAgentText: Bool {
        if case .agentText = self { return true }
        return false
    }

    /// A prompt the agent took: not pending and not refused.
    public var isSettledUserText: Bool {
        if case .userText(let message) = self { return !message.pending && message.sendError == nil }
        return false
    }

    /// The session-protocol turn id, on agent rows that have one.
    public var turn: String? {
        switch self {
        case .agentText(let message): message.turn
        case .toolCall(let message): message.turn
        case .agentEvent(let message): message.turn
        case .userText, .unsupported: nil
        }
    }

    public var hasPendingPermission: Bool {
        if case .toolCall(let message) = self { return message.tool.permission?.status == .pending }
        return false
    }
}
