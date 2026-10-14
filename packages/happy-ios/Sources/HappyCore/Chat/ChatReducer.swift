import Foundation
import HappyStore
import HappyWire

/// The visible and status changes caused by one incremental reduction.
public struct ChatReduction: Equatable, Sendable {
    /// Changed root rows, including roots whose sidechain changed.
    public var messages: [ChatMessage]
    /// Existing user rows settled by receipts, rather than new chat content.
    public var settledMessageIds: Set<String>
    /// Whether this batch contained a previously unseen ready event.
    public var hasReadyEvent: Bool
    /// Latest usage after this batch, for the composer's context meter.
    public var usage: ChatUsage?
    /// Latest validated TodoWrite result, retained across incremental batches.
    public var todos: JSONValue?
}

/// Stateful port of reducer.ts and its tracer. Records are processed once;
/// joins use provider IDs, not names or timestamps. No UIKit or network work.
public struct ChatReducer: Sendable {
    private struct Receipt: Sendable {
        var time: Int64
        var error: String?
    }
    private struct Result: Sendable {
        var time: Int64
        var value: JSONValue
        var error: Bool
    }
    private var rows: [String: ChatMessage] = [:]
    private var seen: Set<String> = []
    private var serverIds: [String: String] = [:]
    private var localIds: [String: String] = [:]
    private var ackIds: [String: String] = [:]
    private var receipts: [String: Receipt] = [:]
    private var tools: [String: String] = [:]
    private var permissions: [String: ToolCall] = [:]
    private var sidechainTools: [String: String] = [:]
    private var toolOwners: [String: String] = [:]
    private var unmatchedResults: [String: Result] = [:]
    private var orphanChildren: [String: Set<String>] = [:]
    private var children: [String: [String]] = [:]
    private var parents: [String: String] = [:]
    private var sorted: [ChatMessage] = []
    private var positions: [String: Int] = [:]
    private var changed: Set<String> = []
    private var settled: Set<String> = []
    private var usageTime: Int64 = .min
    private var todosTime: Int64 = .min
    /// The newest model usage, including usage-only service records.
    public private(set) var usage: ChatUsage?
    /// The newest validated todos, updated only after a successful result.
    public private(set) var todos: JSONValue?
    /// Number of distinct normalized records processed; useful for verifying
    /// that a feed append does not reduce the entire history again.
    public private(set) var processedRecordCount = 0

    /// Creates an empty session reducer. Keep one instance across batches.
    public init() {}

    /// Current root rows in display order, with sidechains nested in tools.
    public var messages: [ChatMessage] { sorted }

    /// Folds appended records and the latest permission state into chat.
    /// Missing calls and sidechain owners remain buffered across batches.
    public mutating func reduce(
        _ records: [NormalizedChatRecord], agentState: JSONValue? = nil,
        holdUserMessagesUntilAccepted: Bool = false
    ) -> ChatReduction {
        ThreadRules.assertOffMain()
        changed = []
        settled = []
        var ready = false
        var fresh: [NormalizedChatRecord] = []
        for var record in records {
            if case .user = record.body, let local = record.localId, let row = localIds[local] {
                join(serverId: record.id, rowId: row)
                continue
            }
            guard seen.insert(record.id).inserted else {
                continue
            }
            processedRecordCount += 1
            if record.parent == nil, let event = messageToEvent(record) {
                record.body = .event(event)
            }
            if case .event(let event) = record.body {
                switch event {
                case .userMessageAccepted(let ref): receive(ref, receipt: Receipt(time: record.createdAt))
                case .userMessageRejected(let ref, let reason):
                    receive(ref, receipt: Receipt(time: record.createdAt, error: reason))
                case .ready: ready = true
                case .message("Turn started"): break
                default:
                    if event == .message("Context was reset") {
                        if record.createdAt > todosTime {
                            todos = .array([])
                            todosTime = record.createdAt
                        }
                        resetUsage(at: record.createdAt)
                    } else if event == .message("Compaction completed") {
                        resetUsage(at: record.createdAt)
                    }
                    put(
                        .agentEvent(
                            AgentEventMessage(
                                id: record.id, createdAt: record.createdAt, turn: record.turn, event: event,
                                meta: record.meta)))
                }
            } else {
                fresh.append(record)
            }
        }

        // Permissions first: tool-start fills an existing placeholder without
        // changing its identity or its original timestamp.
        applyPermissions(agentState, incoming: fresh)

        // All calls precede all results in a batch, even when records arrived
        // out of sequence (the same order as the JS phases).
        for record in fresh {
            switch record.body {
            case .user(let text):
                if let local = record.localId, let row = localIds[local] {
                    join(serverId: record.id, rowId: row)
                    continue
                }
                let hold =
                    holdUserMessagesUntilAccepted
                    && (record.id == record.localId || record.meta?.expectsAcceptance == true)
                let rowId = record.localId ?? record.id
                put(
                    .userText(
                        UserTextMessage(
                            id: rowId, localId: record.localId, createdAt: record.createdAt, text: text,
                            displayText: record.meta?.displayText, meta: record.meta, pending: hold,
                            sortAt: hold ? ChatMessage.pendingSortKey(record.createdAt) : nil,
                            author: record.author, claudeUuid: record.claudeUuid,
                            codexItemId: record.codexItemId)))
                if let local = record.localId {
                    localIds[local] = rowId
                    if let ack = ackIds.removeValue(forKey: local) {
                        join(serverId: ack, rowId: rowId)
                    }
                }
                join(serverId: record.id, rowId: rowId)
            case .agent(let blocks):
                updateUsage(record.usage, at: record.createdAt)
                for (index, block) in blocks.enumerated() {
                    let rowId = "\(record.id):\(index)"
                    switch block {
                    case .text(let text, let thinking):
                        if let reference = record.parent, let owner = toolOwners[reference],
                            case .toolCall(let parent) = rows[owner],
                            (children[owner] ?? []).isEmpty,
                            let prompt = parent.tool.input["prompt"]?.stringValue,
                            !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                            text.trimmingCharacters(in: .whitespacesAndNewlines)
                                == prompt.trimmingCharacters(in: .whitespacesAndNewlines)
                        {
                            continue
                        }
                        put(
                            .agentText(
                                AgentTextMessage(
                                    id: rowId, createdAt: record.createdAt, turn: record.turn,
                                    text: thinking ? "*\(text)*" : text, isThinking: thinking,
                                    meta: record.meta)))
                        attach(rowId, to: record.parent)
                    case .call(let call, let name, let title, let input, let description):
                        let side = record.parent.flatMap { toolOwners[$0] } != nil
                        let existing = side ? sidechainTools[call] : tools[call]
                        let target = existing ?? rowId
                        if let existing, case .toolCall(var row) = rows[existing] {
                            row.tool.input = merge(row.tool.input, input)
                            row.tool.description = description
                            row.tool.title = title ?? row.tool.title
                            row.tool.startedAt = record.createdAt
                            row.turn = row.turn ?? record.turn
                            if row.tool.permission?.status == .approved && row.tool.state == .completed {
                                row.tool.state = .running
                                row.tool.result = nil
                                row.tool.completedAt = nil
                            }
                            put(.toolCall(row))
                        } else {
                            var tool = ToolCall(
                                callId: call, name: name, title: title, state: .running, input: input,
                                createdAt: record.createdAt, startedAt: record.createdAt,
                                description: description)
                            if let permission = permissions[call] {
                                tool.permission = permission.permission
                                tool.createdAt = permission.createdAt
                                tool.input = merge(permission.input, input)
                                if permission.permission?.status != .approved {
                                    tool.state = .error
                                    tool.completedAt = permission.completedAt ?? record.createdAt
                                    tool.result = permission.result
                                }
                            }
                            if side, let main = tools[call], case .toolCall(let permissionRow) = rows[main] {
                                tool.permission = permissionRow.tool.permission
                            }
                            put(
                                .toolCall(
                                    ToolCallMessage(
                                        id: target, createdAt: record.createdAt, turn: record.turn,
                                        tool: tool, meta: record.meta)))
                        }
                        if side {
                            sidechainTools[call] = target
                        } else {
                            tools[call] = target
                        }
                        toolOwners[call] = target
                        adoptOrphans(reference: call)
                        if let alias = input["sessionSubagent"]?.stringValue {
                            toolOwners[alias] = target
                            adoptOrphans(reference: alias)
                        }
                        attach(target, to: record.parent)
                        if let result = unmatchedResults.removeValue(forKey: call) {
                            applyResult(call: call, result: result)
                        }
                    case .result: break
                    }
                }
            case .unsupported(let kind):
                put(.unsupported(UnsupportedMessage(id: record.id, createdAt: record.createdAt, kind: kind)))
            case .event: break
            }
        }
        // Trace again after every call is indexed; a session subagent may
        // precede its owner within a fetched page.
        for record in fresh {
            if case .agent(let blocks) = record.body {
                for (index, block) in blocks.enumerated() {
                    switch block {
                    case .text: attach("\(record.id):\(index)", to: record.parent)
                    case .call(let call, _, _, _, _):
                        if let row = sidechainTools[call] ?? tools[call] {
                            attach(row, to: record.parent)
                        }
                    case .result(let call, let value, let error):
                        let result = Result(time: record.createdAt, value: value, error: error)
                        if tools[call] == nil && sidechainTools[call] == nil {
                            // A socket result may outrun the lower-seq delta
                            // containing its call. Preserve the first outcome.
                            if unmatchedResults[call] == nil {
                                unmatchedResults[call] = result
                            }
                        } else {
                            applyResult(call: call, result: result)
                        }
                    }
                }
            }
        }
        refreshSorted()
        return ChatReduction(
            messages: changed.compactMap { root($0) == $0 ? materialize($0) : nil },
            settledMessageIds: settled, hasReadyEvent: ready, usage: usage, todos: todos)
    }

    /// Joins send acknowledgements with local rows, even if the socket echo
    /// never arrives. Returns rows settled by already-buffered receipts.
    public mutating func registerUserMessageServerIds(_ pairs: [(serverId: String, localId: String)])
        -> [ChatMessage]
    {
        changed = []
        settled = []
        for pair in pairs {
            if let row = localIds[pair.localId] {
                join(serverId: pair.serverId, rowId: row)
            } else {
                ackIds[pair.localId] = pair.serverId
            }
        }
        refreshSorted()
        return changed.compactMap { rows[$0] }
    }

    private mutating func receive(_ ref: String, receipt: Receipt) {
        if let row = serverIds[ref] {
            settle(row, receipt: receipt)
        } else {
            receipts[ref] = receipt
        }
    }

    private mutating func applyResult(call: String, result: Result) {
        var targets = Set<String>()
        if let row = tools[call] {
            targets.insert(row)
        }
        if let row = sidechainTools[call] {
            targets.insert(row)
        }
        for target in targets {
            guard case .toolCall(var row) = rows[target], row.tool.state == .running else {
                continue
            }
            row.tool.state = result.error ? .error : .completed
            row.tool.result = result.value
            row.tool.completedAt = result.time
            put(.toolCall(row))
            if row.tool.name == "TodoWrite", !result.error {
                updateTodos(result.value["newTodos"], at: result.time)
            }
        }
    }

    private mutating func join(serverId: String, rowId: String) {
        if serverIds[serverId] == nil {
            serverIds[serverId] = rowId
        }
        if let receipt = receipts.removeValue(forKey: serverId) {
            settle(rowId, receipt: receipt)
        }
    }

    private mutating func settle(_ id: String, receipt: Receipt) {
        guard case .userText(var row) = rows[id], row.pending || row.sortAt == nil else {
            return
        }
        row.pending = false
        row.sortAt = receipt.time
        row.sendError = receipt.error
        put(.userText(row))
        settled.insert(id)
    }

    private mutating func applyPermissions(_ state: JSONValue?, incoming: [NormalizedChatRecord]) {
        let incomingCalls = Set(
            incoming.flatMap { record -> [String] in
                guard case .agent(let blocks) = record.body else {
                    return []
                }
                return blocks.compactMap {
                    if case .call(let id, _, _, _, _) = $0 {
                        return id
                    }
                    return nil
                }
            })
        let completed = state?["completedRequests"]?.objectValue ?? [:]
        let pending = state?["requests"]?.objectValue ?? [:]
        for (id, request) in pending.sorted(by: { $0.key < $1.key }) where completed[id] == nil {
            permission(id: id, value: request, status: .pending, incomingCalls: incomingCalls)
        }
        for (id, request) in completed.sorted(by: { $0.key < $1.key }) {
            guard let statusName = request["status"]?.stringValue,
                let status = ToolPermission.Status(rawValue: statusName)
            else {
                continue
            }
            permission(id: id, value: request, status: status, incomingCalls: incomingCalls)
        }
    }

    private mutating func permission(
        id: String, value: JSONValue, status: ToolPermission.Status, incomingCalls: Set<String>
    ) {
        let call = value["toolUseId"]?.stringValue ?? id
        guard let name = value["tool"]?.stringValue else {
            return
        }
        let time = ChatNormalizer.safeTime(value["createdAt"]) ?? 0
        let ended = ChatNormalizer.safeTime(value["completedAt"]) ?? time
        let permission = ToolPermission(
            id: id, status: status, reason: value["reason"]?.stringValue, mode: value["mode"]?.stringValue,
            allowedTools: (value["allowedTools"] ?? value["allowTools"])?.arrayValue?.compactMap(
                \.stringValue),
            decision: value["decision"]?.stringValue.flatMap(ToolPermission.Decision.init(rawValue:)))
        let target = tools[call] ?? "permission:\(id)"
        if case .toolCall(var row) = rows[target] {
            if status == .pending {
                guard row.tool.permission == nil else {
                    return
                }
            } else {
                guard row.tool.permission?.date == nil,
                    !(row.tool.startedAt != nil && row.tool.permission?.status == .approved)
                else {
                    return
                }
            }
            row.tool.permission = permission
            if status == .denied || status == .canceled, row.tool.state == .running {
                row.tool.state = .error
                row.tool.completedAt = ended
                if row.tool.result == nil, let reason = permission.reason {
                    row.tool.result = .object(["error": .string(reason)])
                }
            }
            put(.toolCall(row))
            permissions[call] = row.tool
        } else {
            let result: JSONValue? =
                status == .approved
                ? .string("Approved") : permission.reason.map { .object(["error": .string($0)]) }
            let tool = ToolCall(
                callId: call, name: name,
                state: status == .pending ? .running : status == .approved ? .completed : .error,
                input: value["arguments"] ?? .object([:]), createdAt: time,
                completedAt: status == .pending ? nil : ended, result: result, permission: permission)
            permissions[call] = tool
            if status != .pending && incomingCalls.contains(call) {
                return
            }
            put(.toolCall(ToolCallMessage(id: target, createdAt: time, tool: tool)))
            tools[call] = target
        }
    }

    private func merge(_ existing: JSONValue, _ next: JSONValue) -> JSONValue {
        if let a = existing.objectValue, let b = next.objectValue {
            return .object(a.merging(b) { _, new in new })
        }
        return next
    }

    private mutating func put(_ row: ChatMessage) {
        guard rows[row.id] != row else {
            return
        }
        rows[row.id] = row
        changed.insert(row.id)
        changed.insert(root(row.id))
    }

    private mutating func attach(_ row: String, to reference: String?) {
        guard let reference, rows[row] != nil, parents[row] == nil else {
            return
        }
        guard let parent = toolOwners[reference] else {
            orphanChildren[reference, default: []].insert(row)
            return
        }
        guard parent != row else {
            return
        }
        // Never let malformed producer references create a recursive cycle.
        var ancestor: String? = parent
        while let id = ancestor {
            if id == row {
                return
            }
            ancestor = parents[id]
        }
        parents[row] = parent
        children[parent, default: []].append(row)
        changed.insert(row)
        changed.insert(root(parent))
    }

    private mutating func adoptOrphans(reference: String) {
        guard let waiting = orphanChildren.removeValue(forKey: reference) else {
            return
        }
        let ids = waiting.sorted { a, b in
            guard let a = rows[a], let b = rows[b] else {
                return a < b
            }
            return ordered(a, b)
        }
        for id in ids {
            attach(id, to: reference)
        }
    }

    private func root(_ id: String) -> String {
        var id = id
        while let parent = parents[id] {
            id = parent
        }
        return id
    }

    private func materialize(_ id: String) -> ChatMessage? {
        guard let row = rows[id] else {
            return nil
        }
        if case .toolCall(var tool) = row {
            tool.children = (children[id] ?? []).compactMap(materialize).sorted(by: ordered)
            return .toolCall(tool)
        }
        return row
    }

    private func ordered(_ a: ChatMessage, _ b: ChatMessage) -> Bool {
        a.sortKey == b.sortKey ? a.id < b.id : a.sortKey < b.sortKey
    }

    private mutating func refreshSorted() {
        if sorted.isEmpty {
            sorted = changed.compactMap { parents[$0] == nil ? materialize($0) : nil }.sorted(by: ordered)
            positions = Dictionary(
                uniqueKeysWithValues: sorted.enumerated().map { ($0.element.id, $0.offset) })
            return
        }
        for id in changed.sorted() {
            if let index = positions[id] {
                if parents[id] == nil, let row = materialize(id), row.sortKey == sorted[index].sortKey {
                    sorted[index] = row
                    continue
                }
                sorted.remove(at: index)
                positions.removeValue(forKey: id)
                for i in index..<sorted.count {
                    positions[sorted[i].id] = i
                }
            }
            guard parents[id] == nil, let row = materialize(id) else {
                continue
            }
            var lo = 0, hi = sorted.count
            while lo < hi {
                let mid = (lo + hi) / 2
                if ordered(sorted[mid], row) {
                    lo = mid + 1
                } else {
                    hi = mid
                }
            }
            sorted.insert(row, at: lo)
            for i in lo..<sorted.count {
                positions[sorted[i].id] = i
            }
        }
    }

    private mutating func resetUsage(at time: Int64) {
        // Equal timestamps retain the already accepted state, matching
        // updateUsage/updateTodos when older pages arrive incrementally.
        guard time > usageTime else { return }
        usageTime = time
        usage = ChatUsage(inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0, contextSize: 0)
    }

    private mutating func updateUsage(_ value: SessionUsage?, at time: Int64) {
        guard let value, time > usageTime else {
            return
        }
        usageTime = time
        let cache = value.cacheCreationInputTokens ?? 0, read = value.cacheReadInputTokens ?? 0
        let context = [value.inputTokens, cache, read].reduce(0) { sum, next in
            let (sum, overflow) = sum.addingReportingOverflow(next)
            return overflow ? (next >= 0 ? Int.max : Int.min) : sum
        }
        usage = ChatUsage(
            inputTokens: value.inputTokens, outputTokens: value.outputTokens, cacheCreation: cache,
            cacheRead: read, contextSize: context,
            contextWindow: value.contextWindow.flatMap { $0 > 0 ? $0 : nil })
    }

    private mutating func updateTodos(_ value: JSONValue?, at time: Int64) {
        guard time > todosTime, let value, let items = value.arrayValue,
            items.allSatisfy({ item in
                item["content"]?.stringValue != nil
                    && ["pending", "in_progress", "completed"].contains(item["status"]?.stringValue ?? "")
                    && (item["priority"] == nil
                        || ["high", "medium", "low"].contains(item["priority"]?.stringValue ?? ""))
                    && (item["id"] == nil || item["id"]?.stringValue != nil)
            })
        else {
            return
        }
        todos = value
        todosTime = time
    }

    private func messageToEvent(_ record: NormalizedChatRecord) -> AgentEvent? {
        guard case .agent(let blocks) = record.body else {
            return nil
        }
        for block in blocks {
            switch block {
            case .text(let text, _):
                let prefix = "Claude AI usage limit reached|"
                if text.hasPrefix(prefix) {
                    let suffix = text.dropFirst(prefix.count)
                    if !suffix.isEmpty, suffix.allSatisfy(\.isNumber), let time = Int64(suffix) {
                        return .limitReached(endsAt: time)
                    }
                }
            case .call(_, let name, _, let input, _):
                if name == "mcp__happy__change_title", let title = input["title"]?.stringValue {
                    return .message("Title changed to \"\(title)\"")
                }
                if name == "EnterPlanMode" || name == "enter_plan_mode" {
                    return .message("Entering plan mode")
                }
            default: break
            }
        }
        return nil
    }
}

extension ChatMessage {
    static func pendingSortKey(_ time: Int64) -> Int64 {
        let (key, overflow) = time.addingReportingOverflow(pendingSortOffset)
        return overflow ? .max : key
    }
}
