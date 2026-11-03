import Foundation
import HappyWire

/// Where the Feed keeps what it last showed: the engine's checkpoints.
public protocol FeedKeep: Sendable {
    func read(_ key: String) async -> JSONValue?
    func write(_ key: String, _ value: JSONValue) async
}

/// One paired computer's Feed for its person (API.md "Feed"), kept on the
/// phone (docs/offline-first.md): read from disk first, then the newest
/// page from the computer, then kept current by the `feed.*` events the
/// engine hands it. Entries merge by `id`, the greater `version` winning,
/// newest `cursor` first, so a replayed or late event never moves anything
/// back.
///
/// Seeing is an intent (`feed.seen` per subject, `feed.readAll`): an entry
/// reads as seen at once, kept through a relaunch and sent once the
/// computer is reachable; the computer's answer then closes the held copy.
/// The unread count is the computer's, newest by event cursor, less the
/// open entries this phone has seen and not yet sent.
///
/// Only a computer whose health says `capabilities.feed` and whose
/// bootstrap carries `feedUnread` has one; older daemons, and guests, show
/// none.
public actor FeedLibrary {
    public struct State: Equatable, Sendable {
        /// Whether this computer keeps a feed for this person; nil until it
        /// has said, on this phone ever.
        public var available: Bool?
        /// Newest `cursor` first.
        public var items: [FeedItem] = []
        /// Entries this phone has seen that the computer still calls open.
        public var seenHere: Set<String> = []
        /// How many entries are open, as this phone shows it.
        public var unread = 0
        /// Older entries exist beyond the last one held.
        public var hasMore = false
        /// Something was read, from disk or the computer.
        public var loaded = false
        public var refreshing = false
        public var loadingMore = false
        /// The last read failed, and why.
        public var error: String?
        /// The people entries credit, by user ID, as they are read.
        public var people: [String: TeamUser] = [:]

        public init() {}

        /// Whether `item` shows as not looked at.
        public func isUnread(_ item: FeedItem) -> Bool { item.open && !seenHere.contains(item.id) }
    }

    /// The checkpoint it is kept under, in the account's `direct.sqlite`.
    public static let resource = "feed"
    /// One read's page.
    static let page = 50
    /// The most entries kept on disk.
    static let keptLimit = 200
    static let peekLimit = 200

    private let routes: FeedRoutes
    private let outbox: IntentOutbox
    private let keep: FeedKeep
    private let now: @Sendable () -> Double
    private var state = State()
    private var listeners: [UUID: AsyncStream<State>.Continuation] = [:]
    /// What the computer last said, before this phone's seeing is laid over it.
    private var held: [FeedItem] = []
    private var serverUnread = 0
    /// The event cursor `serverUnread` is as of; an older one is ignored.
    private var unreadCursor: String?
    /// What health said of the Feed on this connection, and whether the
    /// last bootstrap carried a count.
    private var capable: Bool?
    private var counted: Bool?
    private var pending: [Intent] = []
    private var live = false
    private var started = false
    private var following: [Task<Void, Never>] = []
    private var connecting: Task<Void, Never>?
    private var reading: Task<Void, Never>?
    private var again = false
    private var peopleRead: Task<Void, Never>?
    private var peopleMissing: Set<String> = []
    private var lastKept: JSONValue?

    public init(routes: FeedRoutes, outbox: IntentOutbox, keep: FeedKeep,
                now: @escaping @Sendable () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded(.down) }) {
        self.routes = routes
        self.outbox = outbox
        self.keep = keep
        self.now = now
    }

    /// The state now and after every change.
    public func states() -> AsyncStream<State> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: State.self, bufferingPolicy: .bufferingNewest(1))
        listeners[id] = continuation
        continuation.yield(state)
        continuation.onTermination = { [weak self] _ in Task { await self?.unlisten(id) } }
        return stream
    }

    private func unlisten(_ id: UUID) { listeners[id] = nil }

    public var current: State { state }

    // MARK: Lifecycle

    /// What was kept, and this phone's seeing still on its way. Once.
    public func start() async {
        guard !started else { return }
        started = true
        #if DEBUG
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        if let kept = await keep.read(Self.resource) {
            lastKept = kept
            state.available = kept["available"]?.boolValue
            held = Self.decode(kept["items"])
            serverUnread = max(0, Int(kept["unread"]?.numberValue ?? 0))
            unreadCursor = kept["unreadCursor"]?.stringValue
            state.hasMore = kept["hasMore"]?.boolValue ?? false
            let people = (try? JSONDecoder().decode([Lossy<TeamUser>].self, from: JSONEncoder().encode(kept["people"] ?? .array([])))) ?? []
            state.people = Dictionary(people.compactMap(\.value).map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
            state.loaded = true
        }
        pending = await outbox.pending().filter(\.kind.isFeed)
        let outbox = outbox
        following.append(Task { [weak self] in
            for await list in await outbox.changes() { await self?.intentsChanged(list) }
        })
        // What was kept shows at once, with this phone's seeing over it.
        await commit()
    }

    public func stop() {
        for task in following { task.cancel() }
        following = []
        connecting?.cancel(); connecting = nil
        reading?.cancel(); reading = nil
        peopleRead?.cancel(); peopleRead = nil
        live = false
        for listener in listeners.values { listener.finish() }
        listeners = [:]
    }

    /// The bootstrap was read: its `feedUnread` (nil from a daemon or for
    /// a person without a feed), as of its event `cursor`.
    public func bootstrap(unread: Int?, cursor: String?) async {
        counted = unread != nil
        if let unread { setUnread(unread, cursor: cursor) }
        await settleAvailability()
        await commit()
    }

    /// The event stream opened: health says whether there is a feed, and
    /// the newest page is read, on its own task, so the stream reads on.
    public func connected() {
        live = true
        connecting?.cancel()
        connecting = Task { [weak self, routes] in
            let capable: Bool? = try? await routes.feedCapable()
            guard !Task.isCancelled else { return }
            await self?.healthAnswered(capable)
        }
    }

    /// The stream went away: reads under way stop.
    public func disconnected() {
        live = false
        connecting?.cancel(); connecting = nil
        reading?.cancel(); reading = nil
        again = false
        if state.refreshing || state.loadingMore {
            state.refreshing = false
            state.loadingMore = false
            publish()
        }
    }

    private func healthAnswered(_ capable: Bool?) async {
        connecting = nil
        if let capable { self.capable = capable }
        await settleAvailability()
        await commit()
        if state.available == true { await refresh() }
    }

    /// A feed both health and the bootstrap vouch for; either saying no
    /// takes it away, with what was kept of it.
    private func settleAvailability() async {
        let next: Bool?
        if capable == false || counted == false { next = false }
        else if capable == true && counted == true { next = true }
        else { next = state.available }
        guard next != state.available else { return }
        state.available = next
        if next == false {
            held = []
            serverUnread = 0
            unreadCursor = nil
            state.hasMore = false
            state.error = nil
        }
    }

    // MARK: Reading

    /// Reads the newest page and lays it over what is held: entries newer
    /// than its last one are exactly the page, older ones already read
    /// stay, so a person scrolled down keeps their place. One under way is
    /// followed by one more.
    public func refresh() async {
        guard state.available == true else { return }
        if let reading {
            again = true
            await reading.value
            return
        }
        let task = Task { await self.readFirst() }
        reading = task
        await task.value
        reading = nil
        if again {
            again = false
            await refresh()
        }
    }

    private func readFirst() async {
        state.refreshing = true
        publish()
        defer { state.refreshing = false; publish() }
        let page: FeedPage
        do {
            page = try await routes.feed(before: nil, limit: Self.page)
        } catch AgentClientError.status(404, _, _) {
            // No feed for this person after all (a guest, an older daemon).
            capable = false
            await settleAvailability()
            await commit()
            return
        } catch {
            guard !Task.isCancelled, !(error is CancellationError) else { return }
            state.error = Store.describe(error)
            return
        }
        guard !Task.isCancelled else { return }
        let floor = page.items.last?.cursor
        let ids = Set(page.items.map(\.id))
        let older = floor == nil || !page.hasMore ? [] : held.filter { $0.cursor < floor! && !ids.contains($0.id) }
        let olderIds = Set(older.map(\.id))
        held = Self.upsert(held.filter { ids.contains($0.id) || olderIds.contains($0.id) }, page.items, hasMore: false)
        state.hasMore = older.isEmpty ? page.hasMore : state.hasMore
        state.error = nil
        state.loaded = true
        setUnread(page.unread, cursor: page.cursor)
        await commit()
    }

    /// Reads the page older than the last entry held.
    public func loadMore() async {
        guard live, state.available == true, state.hasMore, !state.loadingMore, let last = held.last else { return }
        state.loadingMore = true
        publish()
        defer { state.loadingMore = false; publish() }
        do {
            let page = try await routes.feed(before: last.cursor, limit: Self.page)
            var merged = held
            let ids = Set(merged.map(\.id))
            merged += page.items.filter { !ids.contains($0.id) }
            held = Self.upsert(merged.sorted(by: Self.newestFirst), page.items, hasMore: false)
            state.hasMore = page.hasMore
            state.error = nil
            await commit()
        } catch {
            guard !(error is CancellationError) else { return }
            state.error = Store.describe(error)
        }
    }

    /// One `feed.*` event, in stream order.
    public func receive(_ event: JSONValue) async {
        guard let type = event["type"]?.stringValue, let payload = event["payload"] else { return }
        switch type {
        case "feed.item.created", "feed.item.updated":
            guard state.available != false, let item = Self.decode(.array([payload["item"] ?? .null])).first else { return }
            held = Self.upsert(held, [item], hasMore: state.hasMore)
        case "feed.item.removed":
            guard let id = payload["itemId"]?.stringValue else { return }
            held.removeAll { $0.id == id }
        case "feed.unread.updated":
            guard let unread = payload["unread"]?.numberValue else { return }
            setUnread(max(0, Int(unread)), cursor: event["cursor"]?.stringValue)
        default:
            return
        }
        await commit()
    }

    // MARK: Seeing

    /// The person opened `item` from the feed: its subject is seen through
    /// the change it showed, so a newer one keeps it open.
    public func open(_ item: FeedItem) async {
        guard state.available == true, state.isUnread(item), !item.version.isEmpty else { return }
        await enqueueSeen(item.subject, through: item.cursor)
    }

    /// The person opened `subject` elsewhere (an artifact, a Surface): its
    /// open entry closes, whatever it holds. Nothing is sent to a computer
    /// without a feed, nor while nothing is unread or its entry, held here,
    /// is already seen.
    public func seen(_ subject: FeedSubject) async {
        guard state.available == true, state.unread > 0 else { return }
        if let entry = state.items.first(where: { $0.subject == subject }), !state.isUnread(entry) { return }
        await enqueueSeen(subject, through: nil)
    }

    private func enqueueSeen(_ subject: FeedSubject, through: String?) async {
        var value: [String: JSONValue] = ["type": .string(subject.type), "id": .string(subject.id)]
        if let through { value["through"] = .string(through) }
        _ = try? await outbox.enqueue(.feedSeen, target: subject.key, value: .object(value))
        // The outbox publishes the change; this shows it without waiting.
        pending = await outbox.pending().filter(\.kind.isFeed)
        await commit()
    }

    /// Every entry read, up to the newest one shown: entries that arrive
    /// meanwhile stay open.
    public func readAll() async {
        guard state.available == true, let newest = held.first, held.contains(where: state.isUnread) || state.unread > 0 else { return }
        _ = try? await outbox.enqueue(.feedReadAll, target: "all", value: .object(["through": .string(newest.cursor)]))
        pending = await outbox.pending().filter(\.kind.isFeed)
        await commit()
    }

    private func intentsChanged(_ list: [Intent]) async {
        let next = list.filter(\.kind.isFeed)
        guard next != pending else { return }
        pending = next
        await commit()
    }

    /// Sends one of the Feed's intents: the computer's answer closes the
    /// held copies at once. Gone (an older daemon's `404`) counts as done;
    /// any other 4xx but 408 and 429 is a refusal.
    public func deliver(_ intent: Intent) async throws {
        do {
            switch intent.kind {
            case .feedSeen:
                guard let type = intent.value["type"]?.stringValue, let id = intent.value["id"]?.stringValue else { return }
                let answer = try await routes.markFeedSeen(FeedSubject(type: type, id: id), through: intent.value["through"]?.stringValue, mutationId: intent.id)
                held = Self.upsert(held, answer.items, hasMore: false)
                setUnread(answer.unread, cursor: nil)
            case .feedReadAll:
                let through = intent.value["through"]?.stringValue
                let unread = try await routes.markFeedReadAll(through: through, mutationId: intent.id)
                // By its contract every entry open at or before `through`
                // is now closed, whether or not its own event has come; a
                // later change arrives with a greater version.
                let at = now()
                held = held.map { item in
                    guard item.open, through.map({ item.cursor <= $0 }) ?? true else { return item }
                    var item = item
                    item.seenAt = at
                    return item
                }
                setUnread(unread, cursor: nil)
            default:
                return
            }
        } catch AgentClientError.status(404, _, _) {
            return
        } catch let error as AgentClientError {
            if let status = error.status, (400..<500).contains(status), status != 408, status != 429 {
                throw IntentRefusal(Store.describe(error))
            }
            throw error
        }
        await commit()
    }

    // MARK: Following

    /// The places the feed gathers from, read whole each time.
    public func clusters() async throws -> [FeedCluster] {
        try await routes.feedClusters()
    }

    /// Follows `cluster`, or mutes it; what the computer says it is now.
    public func follow(_ cluster: String, _ following: Bool) async throws -> FeedCluster {
        try await routes.followFeedCluster(cluster, follow: following, mutationId: ClientID.make())
    }

    /// What happened in `cluster` lately, without following it. Its people
    /// are read like the feed's.
    public func peek(_ cluster: String) async throws -> FeedPeek {
        let peek = try await routes.peekFeedCluster(cluster, limit: Self.peekLimit)
        readPeople(peek.entries)
        return peek
    }

    // MARK: State

    private func setUnread(_ value: Int, cursor: String?) {
        if let cursor {
            if let held = unreadCursor, cursor < held { return }
            unreadCursor = cursor
        }
        serverUnread = max(0, value)
    }

    /// Whether this phone's seeing, still on its way, covers `item`.
    private func covered(_ item: FeedItem) -> Bool {
        guard item.open else { return false }
        for intent in pending {
            let through = intent.value["through"]?.stringValue
            switch intent.kind {
            case .feedSeen where intent.target == item.subject.key, .feedReadAll:
                if through.map({ item.cursor <= $0 }) ?? true { return true }
            default:
                continue
            }
        }
        return false
    }

    /// Lays this phone's seeing over what is held, shows it, and writes it
    /// down when what is kept changed.
    private func commit() async {
        let available = state.available == true
        state.items = available ? held : []
        let seen = Set(state.items.filter(covered).map(\.id))
        state.seenHere = seen
        state.unread = available ? max(0, serverUnread - seen.count) : 0
        readPeople(state.items)
        publish()
        await save()
    }

    private func save() async {
        var object: [String: JSONValue] = [
            "items": (try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(Array(held.prefix(Self.keptLimit))))) ?? .array([]),
            "unread": .number(Double(serverUnread)),
            "hasMore": .bool(state.hasMore || held.count > Self.keptLimit),
        ]
        if let available = state.available { object["available"] = .bool(available) }
        if let unreadCursor { object["unreadCursor"] = .string(unreadCursor) }
        let credited = Set(held.prefix(Self.keptLimit).flatMap { $0.actors.compactMap(\.userId) })
        let people = state.people.values.filter { credited.contains($0.id) }.sorted { $0.id < $1.id }
        object["people"] = (try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(people))) ?? .array([])
        let value = JSONValue.object(object)
        // A change that changed nothing kept writes nothing.
        guard value != lastKept else { return }
        lastKept = value
        await keep.write(Self.resource, value)
    }

    private func publish() {
        for listener in listeners.values { listener.yield(state) }
    }

    /// Reads the people `items` credit that this phone doesn't know yet,
    /// one read at a time; those the computer doesn't name aren't asked
    /// for again while it runs.
    private func readPeople(_ items: [FeedItem]) {
        let wanted = Set(items.flatMap { $0.actors.compactMap(\.userId) }).filter { state.people[$0] == nil && !peopleMissing.contains($0) }
        guard !wanted.isEmpty, peopleRead == nil, live else { return }
        peopleMissing.formUnion(wanted)
        let ids = wanted.sorted()
        peopleRead = Task { [weak self, routes] in
            var read: [TeamUser] = []
            for start in stride(from: 0, to: ids.count, by: 100) {
                guard let page = try? await routes.teamUsers(Array(ids[start..<min(start + 100, ids.count)])) else { break }
                read += page
            }
            await self?.peopleAnswered(read, asked: Set(ids))
        }
    }

    private func peopleAnswered(_ read: [TeamUser], asked: Set<String>) async {
        peopleRead = nil
        var people = state.people
        for user in read { people[user.id] = user }
        // Not answered at all (the computer away): asked again next time.
        if read.isEmpty { peopleMissing.subtract(asked) }
        guard people != state.people else { return }
        state.people = people
        await commit()
    }

    // MARK: Merging

    /// Newest change first. Cursors are UUIDv7s, which sort as text.
    nonisolated static func newestFirst(_ a: FeedItem, _ b: FeedItem) -> Bool {
        a.cursor != b.cursor ? a.cursor > b.cursor : a.id < b.id
    }

    /// `incoming` taken into `current`: the greater `version` of each entry
    /// wins, and with `hasMore` an entry older than the last one held is
    /// left for paging to bring, so the list never has a gap. Unchanged
    /// entries stay as they are.
    nonisolated static func upsert(_ current: [FeedItem], _ incoming: [FeedItem], hasMore: Bool) -> [FeedItem] {
        guard !incoming.isEmpty else { return current }
        var byId = Dictionary(current.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let tail = current.last?.cursor
        var changed = false
        for item in incoming {
            if let held = byId[item.id], held.version >= item.version { continue }
            if byId[item.id] == nil, hasMore, let tail, item.cursor < tail { continue }
            byId[item.id] = item
            changed = true
        }
        return changed ? byId.values.sorted(by: newestFirst) : current
    }

    nonisolated static func decode(_ value: JSONValue?) -> [FeedItem] {
        guard let value, let data = try? JSONEncoder().encode(value) else { return [] }
        return ((try? JSONDecoder().decode([Lossy<FeedItem>].self, from: data)) ?? []).compactMap(\.value)
    }
}

/// The engine's seam to its Feed, made with the engine before the library,
/// like `TodoDelivery`.
final class FeedDelivery: @unchecked Sendable {
    /// Set once, as the engine finishes its init.
    weak var library: FeedLibrary?

    func deliver(_ intent: Intent) async throws {
        guard let library else { throw CancellationError() }
        try await library.deliver(intent)
    }
}
