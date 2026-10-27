import Foundation

extension AgentWire {
    /// An agent as a conversation's detail reads it: what the bootstrap
    /// says of it beyond what a chat needs.
    public struct DetailAgent: Equatable, Sendable, Codable {
        public var id: String
        public var title: String?
        public var status: String
        public var parentAgentId: String?
        public var subtask: Bool?
        public var createdAt: Double?
        public var archivedAt: Double?
        /// Its own lifetime input and output tokens; only children carry it.
        public var totalTokens: Int?
        public var subagents: AgentSubagents?

        public init(id: String, title: String? = nil, status: String = "idle", parentAgentId: String? = nil, subtask: Bool? = nil, createdAt: Double? = nil, archivedAt: Double? = nil, totalTokens: Int? = nil, subagents: AgentSubagents? = nil) {
            self.id = id
            self.title = title
            self.status = status
            self.parentAgentId = parentAgentId
            self.subtask = subtask
            self.createdAt = createdAt
            self.archivedAt = archivedAt
            self.totalTokens = totalTokens
            self.subagents = subagents
        }
    }

    /// A background process an agent started.
    public struct Process: Equatable, Sendable, Codable {
        public var id: String
        public var command: String
        public var status: String
        public var startedAt: Double?
        public var endedAt: Double?

        public init(id: String, command: String, status: String, startedAt: Double? = nil, endedAt: Double? = nil) {
            self.id = id
            self.command = command
            self.status = status
            self.startedAt = startedAt
            self.endedAt = endedAt
        }
    }

    /// One model's lifetime inference totals.
    public struct TokenUsage: Equatable, Sendable, Codable {
        public var input: Double?
        public var output: Double?

        public init(input: Double? = nil, output: Double? = nil) {
            self.input = input
            self.output = output
        }
    }

    /// `GET /v0/agents/:agentId/bootstrap`, for the detail: the agent, its
    /// mode, its subtree's usage by provider then model, and its activity.
    public struct Detail: Equatable, Sendable, Codable {
        public var agent: DetailAgent
        public var mode: Mode?
        public var usage: [String: [String: TokenUsage]]?
        public var processes: [Process]?
        public var subagents: [DetailAgent]?

        public init(agent: DetailAgent, mode: Mode? = nil, usage: [String: [String: TokenUsage]]? = nil, processes: [Process]? = nil, subagents: [DetailAgent]? = nil) {
            self.agent = agent
            self.mode = mode
            self.usage = usage
            self.processes = processes
            self.subagents = subagents
        }
    }
}

/// What a conversation's detail shows: its numbers, and desktop's Activity
/// (`HappyAgentActivityPanel`): the children at work and the terminals
/// running, then the children that have settled.
public struct StemCellsSessionDetail: Equatable, Sendable {
    public struct Child: Equatable, Sendable {
        public var id: String
        public var title: String?
        /// The daemon's status: `idle`, or what it is at.
        public var status: String
        public var archived: Bool
        public var tokens: Int?
        public var running: Bool { status != "idle" && !archived }
    }

    public struct Terminal: Equatable, Sendable {
        public var id: String
        public var command: String
        public var startedAt: Double?
    }

    /// What the daemon calls it, and whether it is a subtask at work: for
    /// one the sidebar doesn't hold.
    public var title: String?
    public var subtask: Bool
    public var working: Bool
    public var createdAt: Double?
    /// Input and output tokens over every model the subtree used, as
    /// desktop counts a child's; nil before any was recorded.
    public var tokens: Int?
    public var subagentsRunning: Int
    public var subagentsTotal: Int
    public var mode: AgentWire.Mode?
    public var running: [Child]
    public var terminals: [Terminal]
    public var completed: [Child]

    public init(_ detail: AgentWire.Detail) {
        title = detail.agent.title
        subtask = detail.agent.subtask == true
        working = detail.agent.status != "idle"
        createdAt = detail.agent.createdAt
        let models = (detail.usage ?? [:]).values.flatMap(\.values)
        tokens = models.isEmpty ? nil : Int(models.reduce(0) { $0 + ($1.input ?? 0) + ($1.output ?? 0) })
        subagentsRunning = detail.agent.subagents?.running ?? 0
        subagentsTotal = detail.agent.subagents?.total ?? (detail.subagents?.count ?? 0)
        mode = detail.mode
        let children = (detail.subagents ?? []).map {
            Child(id: $0.id, title: $0.title, status: $0.status, archived: $0.archivedAt != nil, tokens: $0.totalTokens)
        }
        running = children.filter(\.running)
        completed = children.filter { !$0.running }
        terminals = (detail.processes ?? []).filter { $0.status == "running" }.map {
            Terminal(id: $0.id, command: $0.command, startedAt: $0.startedAt)
        }
    }

    public var isQuiet: Bool { running.isEmpty && terminals.isEmpty && completed.isEmpty }
}

/// Numbers as the detail's tiles say them, words left to the screen.
public enum StemCellsDetailFormat {
    /// 980, 1.2K, 12K, 121M, 1.2B: tenths only under ten, never rounded up.
    public static func tokens(_ count: Int) -> String {
        let count = max(0, count)
        for (unit, size) in [("B", 1_000_000_000), ("M", 1_000_000), ("K", 1_000)] where count >= size {
            if count >= 10 * size { return "\(count / size)\(unit)" }
            let tenths = count * 10 / size
            return (tenths % 10 == 0 ? "\(tenths / 10)" : "\(tenths / 10).\(tenths % 10)") + unit
        }
        return "\(count)"
    }

    public enum Age: Equatable, Sendable {
        case justNow
        case minutes(Int)
        case hours(Int)
        case days(Int)
        case months(Int)
        case years(Int)
    }

    /// How long ago `since` was, in the largest whole unit; both in Unix
    /// milliseconds.
    public static func age(since: Double, now: Double) -> Age {
        let seconds = max(0, (now - since) / 1000)
        let minutes = Int(seconds / 60)
        let hours = minutes / 60
        let days = hours / 24
        if minutes < 1 { return .justNow }
        if hours < 1 { return .minutes(minutes) }
        if days < 1 { return .hours(hours) }
        if days < 30 { return .days(days) }
        if days < 365 { return .months(days / 30) }
        return .years(days / 365)
    }

    /// When something started, as near as a person says it: today or
    /// yesterday at a time, a weekday this week, a date this year, or a
    /// date with its year.
    public enum Started: Equatable, Sendable {
        case today(Date)
        case yesterday(Date)
        case weekday(Date)
        case thisYear(Date)
        case date(Date)
    }

    /// `since` in Unix milliseconds.
    public static func started(since: Double, now: Date, calendar: Calendar = .current) -> Started {
        let date = Date(timeIntervalSince1970: since / 1000)
        if calendar.isDate(date, inSameDayAs: now) { return .today(date) }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return .yesterday(date) }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days > 0, days < 7 { return .weekday(date) }
        if calendar.component(.year, from: date) == calendar.component(.year, from: now) { return .thisYear(date) }
        return .date(date)
    }
}

/// Where a conversation sits in the sidebar's tree, as its detail draws
/// it: nested, its parent, itself among its nearest siblings, and its own
/// children under it, nested again from the parent so the tree reads on
/// its own; at the top level, itself over its children alone.
public enum StemCellsFamily {
    public static func of(_ id: String, in rows: [StemCellsRow], around: Int = 2, children childLimit: Int = 8) -> [StemCellsRow] {
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return [] }
        let depth = rows[index].depth
        let topLevel = depth == 0
        func opens(_ row: StemCellsRow) -> Bool { (row.kind == .space || row.kind == .session) && row.targetKind != "surface" && row.agentId != nil }
        func boundary(_ row: StemCellsRow) -> Bool { (row.kind == .section || row.kind == .separator) && row.depth == 0 }
        // The parent, and where its children start.
        var parent: Int?
        var start = 0
        var j = index - 1
        while j >= 0 {
            let row = rows[j]
            if depth > 0, row.depth == depth - 1, opens(row) { parent = j; start = j + 1; break }
            if depth == 0, boundary(row) {
                if row.kind == .section { parent = j }
                start = j + 1
                break
            }
            j -= 1
        }
        var end = rows.count
        for k in (index + 1)..<rows.count where rows[k].depth < depth || (depth == 0 && boundary(rows[k])) {
            end = k
            break
        }
        let siblings = (start..<end).filter { rows[$0].depth == depth && opens(rows[$0]) }
        let at = siblings.firstIndex(of: index) ?? 0
        let width = 2 * around + 1
        let lower = max(0, min(at - around, siblings.count - width))
        let shown = topLevel ? [index][...] : siblings[lower..<min(siblings.count, lower + width)]
        var children: [Int] = []
        for k in (index + 1)..<rows.count {
            if rows[k].depth <= depth || boundary(rows[k]) { break }
            if rows[k].depth == depth + 1, opens(rows[k]) { children.append(k) }
        }
        // Under a row, everything moves in a level; under a section, siblings stay at its level.
        let nested = !topLevel && parent.map { rows[$0].kind != .section } ?? false
        var family: [StemCellsRow] = []
        if let parent, !topLevel {
            var row = rows[parent]
            row.depth = 0
            row.collapsed = row.kind == .section ? false : nil
            row.hasHiddenSessions = false
            family.append(row)
        }
        for sibling in shown {
            var row = rows[sibling]
            row.depth = nested ? 1 : 0
            row.collapsed = nil
            row.hasHiddenSessions = false
            family.append(row)
            guard sibling == index else { continue }
            for child in children.prefix(max(0, childLimit)) {
                var row = rows[child]
                row.depth = nested ? 2 : 1
                row.collapsed = nil
                row.hasHiddenSessions = false
                family.append(row)
            }
        }
        return family
    }
}

/// A conversation's detail, read off the main thread and read again as its
/// events come: a moment after the first, then at most every two seconds
/// while they keep coming (a working agent streams many).
public actor StemCellsSessionDetailFeed {
    public struct State: Equatable, Sendable {
        public var detail: StemCellsSessionDetail?
        public var error: String?
    }

    private let client: DirectAgentClient
    private let store: StemCellsStore
    private let agentId: String
    private let continuation: AsyncStream<State>.Continuation
    public nonisolated let updates: AsyncStream<State>
    private var following: Task<Void, Never>?
    private var reading: Task<Void, Never>?
    /// Events came while a read was waiting or under way: one more after it.
    private var stale = false
    private var state = State()

    public init(client: DirectAgentClient, store: StemCellsStore, agentId: String) {
        self.client = client
        self.store = store
        self.agentId = agentId
        (updates, continuation) = AsyncStream.makeStream(of: State.self, bufferingPolicy: .bufferingNewest(1))
    }

    public func start() {
        guard following == nil else { return }
        following = Task {
            let events = await store.conversationEvents(agentId)
            if Task.isCancelled { return }
            read(after: .zero)
            for await _ in events {
                if Task.isCancelled { return }
                if reading != nil { stale = true } else { read(after: .milliseconds(400)) }
            }
        }
    }

    public func stop() {
        following?.cancel(); following = nil
        reading?.cancel(); reading = nil
        continuation.finish()
    }

    private func read(after delay: Duration) {
        reading?.cancel()
        stale = false
        let client = client
        let agentId = agentId
        reading = Task {
            if delay > .zero { try? await Task.sleep(for: delay) }
            if Task.isCancelled { return }
            do {
                let detail = try await client.sessionDetail(agentId)
                if Task.isCancelled { return }
                state = State(detail: StemCellsSessionDetail(detail), error: nil)
            } catch {
                if Task.isCancelled { return }
                state.error = StemCellsStore.describe(error)
            }
            continuation.yield(state)
            reading = nil
            if stale { read(after: .seconds(2)) }
        }
    }
}
