import Foundation
import Tailcat

/// What a request to the computer is for. Each category has its own
/// deadline; the event stream and queries share one Tailcat client and
/// files have clients of their own (`TailcatClients`), so a long upload or
/// a broken file client never holds up the event stream or the next call.
public enum RequestCategory: Sendable, CaseIterable {
    /// The event stream: one request that stays open while the computer talks.
    case realtime
    /// Ordinary API calls, small JSON both ways. What a request is unless it says.
    case query
    /// Bytes: pictures and avatars, attachments and messages that carry
    /// images, tool-call media, artifact files; and the in-app browser's
    /// streams, which carry whole pages.
    case file

    /// The category whose clients carry this one's requests: a query goes
    /// over the event stream's client, each on a TCP flow of its own.
    var carrier: RequestCategory { self == .query ? .realtime : self }
}

/// File clients one agent connection may have up at once.
let maxFileClients = 3

/// How recently the shared client must have brought bytes back to be kept
/// through a failure on it: the daemon writes the event stream a heartbeat
/// every 15 seconds.
let carrierHeardWithin: Duration = .seconds(20)

/// One agent connection's Tailcat clients: one shared by `.realtime` and
/// `.query`, and up to `maxFileClients` for `.file`, each made on first
/// use. Every connect is made with a node key of its own, fresh each time:
/// the computer and the DERP relay tell clients apart by node key, and a
/// relay keeps one connection per key, dropping the older of two that
/// share one.
///
/// A file request goes to the file client with the fewest requests in
/// flight. Parallel short requests share one client (each opens its own TCP
/// flow); another is made only when every client carries a request older
/// than a second, up to the cap. Extra clients close after 45 idle seconds.
/// A failure resets only the client it happened on (`reset(_ lease:)`);
/// the others, the event stream's included, stay. A failed query resets
/// the shared client only once nothing has come back over it for
/// `carrierHeardWithin`: one that timed out while the stream's heartbeats
/// arrived never drops the stream. The stream's own failures reset it.
final class TailcatClients<Client: AnyObject & Sendable>: @unchecked Sendable {
    typealias Connect = @Sendable (RequestCategory, NodePrivateKey) async throws -> Client
    typealias Disconnect = @Sendable (Client) async -> Void

    /// One client's place: connected, reset and connected again on its own.
    final class Slot: @unchecked Sendable {
        let category: RequestCategory
        let index: Int
        // Guarded by the pool's lock.
        fileprivate var client: Client?
        fileprivate var connecting: Task<Client, Error>?
        /// Callers waiting on `connecting` and not cancelled.
        fileprivate var waiting = 0
        fileprivate var inFlight = 0
        fileprivate var requests: [UUID: ContinuousClock.Instant] = [:]
        fileprivate var idle: Task<Void, Never>?
        fileprivate var idleGeneration = 0
        /// When `client` last brought bytes back, or connected.
        fileprivate var heard: ContinuousClock.Instant?
        init(category: RequestCategory, index: Int) { self.category = category; self.index = index }
    }

    /// One caller's wait on a slot's connect. Guarded by the pool's lock.
    private final class Waiter: @unchecked Sendable { var left = false }

    /// A request's hold on one client; `release` once its answer or stream is done.
    final class Lease: @unchecked Sendable {
        let slot: Slot
        let client: Client
        private let pool: TailcatClients
        private let request: UUID
        // Guarded by the pool's lock.
        private var released = false

        fileprivate init(slot: Slot, client: Client, pool: TailcatClients, request: UUID) { self.slot = slot; self.client = client; self.pool = pool; self.request = request }

        /// Safe to call more than once, from anywhere.
        func release() {
            pool.locked {
                guard !released else { return }
                released = true
                pool.release(slot, request: request)
            }
        }

        /// Bytes came back over this lease's client.
        func heard() { pool.heard(self) }
    }

    private let connect: Connect
    private let disconnect: Disconnect
    private let fileLimit: Int
    private let now: @Sendable () -> ContinuousClock.Instant
    private let idleTimeout: Duration
    private let newKey: @Sendable () throws -> NodePrivateKey
    private let lock = NSLock()
    private var slots: [Slot] = []
    private var closed = false

    init(fileLimit: Int = maxFileClients, now: @escaping @Sendable () -> ContinuousClock.Instant = { .now }, idleTimeout: Duration = .seconds(45), newKey: @escaping @Sendable () throws -> NodePrivateKey = { try NodePrivateKey.generate() },
         connect: @escaping Connect, disconnect: @escaping Disconnect) {
        self.fileLimit = fileLimit; self.now = now; self.idleTimeout = idleTimeout
        self.newKey = newKey; self.connect = connect; self.disconnect = disconnect
    }

    fileprivate func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }
        return try body()
    }

    /// A client for `category`, connected; waits while its slot connects.
    /// Throws `CancellationError` once closed.
    func lease(_ category: RequestCategory) async throws -> Lease {
        let request = UUID()
        let slot = try locked {
            guard !closed else { throw CancellationError() }
            let slot = pick(category.carrier)
            slot.inFlight += 1
            slot.requests[request] = now()
            slot.idle?.cancel(); slot.idle = nil; slot.idleGeneration += 1
            return slot
        }
        do { return Lease(slot: slot, client: try await client(slot), pool: self, request: request) }
        catch {
            locked { release(slot, request: request) }
            throw error
        }
    }

    /// Under the lock.
    private func pick(_ category: RequestCategory) -> Slot {
        let own = slots.filter { $0.category == category }
        let limit = category == .file ? fileLimit : 1
        let time = now()
        if let idlest = own.min(by: { $0.inFlight < $1.inFlight }) {
            if idlest.inFlight == 0 || own.count >= limit { return idlest }
            if let short = own.filter({ !$0.requests.values.contains(where: { time - $0 >= .seconds(1) }) }).min(by: { $0.inFlight < $1.inFlight }) { return short }
        }
        let slot = Slot(category: category, index: (own.map(\.index).max() ?? -1) + 1)
        slots.append(slot)
        return slot
    }

    /// Under the lock. Keep the first file client warm; retire only idle extras.
    private func release(_ slot: Slot, request: UUID) {
        slot.requests.removeValue(forKey: request)
        slot.inFlight -= 1
        guard !closed, slot.category == .file, slot.index > 0, slot.inFlight == 0 else { return }
        let generation = slot.idleGeneration
        let timeout = idleTimeout
        slot.idle = Task { [weak self] in
            do { try await Task.sleep(for: timeout) } catch { return }
            guard let self else { return }
            let old = self.locked { () -> Client? in
                guard !self.closed, slot.inFlight == 0, slot.connecting == nil, slot.idleGeneration == generation else { return nil }
                self.slots.removeAll { $0 === slot }
                defer { slot.client = nil; slot.idle = nil }
                return slot.client
            }
            if let old { await self.disconnect(old) }
        }
    }

    private func client(_ slot: Slot) async throws -> Client {
        while true {
            let (ready, task) = try locked { () throws -> (Client?, Task<Client, Error>?) in
                guard !closed else { throw CancellationError() }
                if let client = slot.client { return (client, nil) }
                if let connecting = slot.connecting { return (nil, connecting) }
                let connect = connect, newKey = newKey, category = slot.category
                let task = Task { try await connect(category, try newKey()) }
                slot.connecting = task
                return (nil, task)
            }
            if let ready { return ready }
            guard let task else { throw CancellationError() }
            let made: Client
            // One caller cancelled (a read let go of for a newer one) must not
            // cancel a connect others wait on: the event stream and queries
            // share it. Only once every caller let go is it cancelled.
            let waiter = Waiter()
            locked { slot.waiting += 1 }
            do {
                made = try await withTaskCancellationHandler { try await task.value } onCancel: {
                    self.locked {
                        guard !waiter.left else { return }
                        waiter.left = true
                        slot.waiting -= 1
                        if slot.waiting == 0, slot.connecting == task { task.cancel() }
                    }
                }
                locked { if !waiter.left { waiter.left = true; slot.waiting -= 1 } }
            } catch {
                let retry = locked { () -> Bool in
                    if !waiter.left { waiter.left = true; slot.waiting -= 1 }
                    if slot.connecting == task { slot.connecting = nil }
                    // Cancelled for callers that let go, not for this one: connect again.
                    return error is CancellationError && !closed && !Task.isCancelled
                }
                if retry { continue }
                throw error
            }
            // The first caller back keeps it; callers that waited on the same connect see it up once.
            let (kept, owner, isClosed) = locked { () -> (Bool, Bool, Bool) in
                let owner = slot.connecting == task
                if owner { slot.connecting = nil; if !closed { slot.client = made; slot.heard = now() } }
                return (!closed && slot.client === made, owner, closed)
            }
            if kept { return made }
            // Closed while it connected: nobody will close it later.
            if owner { await disconnect(made) }
            if isClosed { throw CancellationError() }
            // Reset while it connected: connect again.
        }
    }

    fileprivate func heard(_ lease: Lease) {
        locked { if lease.slot.client === lease.client { lease.slot.heard = now() } }
    }

    /// Lets go of `lease`'s client after a failure on it, if its slot still
    /// holds it; the next request there connects again. `ifSilent`, the
    /// shared client stays while it was heard from within `carrierHeardWithin`.
    func reset(_ lease: Lease, ifSilent: Bool = false) async {
        let old = locked { () -> Client? in
            guard lease.slot.client === lease.client else { return nil }
            if ifSilent, lease.slot.category == .realtime, let heard = lease.slot.heard, now() - heard < carrierHeardWithin { return nil }
            lease.slot.client = nil
            return lease.client
        }
        if let old { await disconnect(old) }
    }

    /// Lets go of every client carrying `category`: the shared one for
    /// `.realtime` or `.query`, the files' for `.file`. The others stay.
    func reset(_ category: RequestCategory) async {
        let old = locked { () -> [Client] in
            slots.filter { $0.category == category.carrier }.compactMap { slot in
                defer { slot.client = nil }
                return slot.client
            }
        }
        for client in old { await disconnect(client) }
    }

    /// Closes every client; nothing connects again.
    func close() async {
        let old = locked { () -> [Client] in
            closed = true
            return slots.compactMap { slot in
                // A connect that finishes anyway is closed by the caller that waited on it.
                slot.connecting?.cancel()
                slot.idle?.cancel(); slot.idle = nil
                defer { slot.client = nil }
                return slot.client
            }
        }
        for client in old { await disconnect(client) }
    }

    /// Every connected client, busy or not; none is let go.
    func connected() -> [Client] { locked { slots.compactMap(\.client) } }

    /// How many places `category`'s requests have, connected or not.
    func count(_ category: RequestCategory) -> Int { locked { slots.filter { $0.category == category.carrier }.count } }
}
