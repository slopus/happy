import Foundation
import HappyCrypto
import HappyWire

/// The app's one subscription: RevenueCat's `pro`, bought through the App
/// Store (`SubscriptionStore`) and told to RevenueCat's REST API
/// (`RevenueCatAPI`), without its SDK. Everything that sells it or asks
/// about it asks here: voice's sheets and hours, the relay's voice, Support
/// us, Settings.
///
/// **Whose it is.** The Happy account's, by the subject RevenueCat already
/// knows it by (the relay token's `sub`, happy-app's `appUserID`), when one
/// is signed in; otherwise this install's own anonymous customer, so buying
/// needs no sign-in. Signing in after this install bought something asks
/// RevenueCat to bring the install into the account (`identify`) before
/// the account is used. That is not a promise: RevenueCat merges only into
/// an account no install was brought into before, and otherwise just
/// switches; then only Restore moves a purchase. Signing out starts a new
/// install customer, never one an account was brought together with.
///
/// **Access** is only what RevenueCat says, kept a day at most
/// (`ProPassCache`). Everything that asks RevenueCat or the store runs one
/// at a time, and each customer change starts a new generation at once:
/// nothing is granted or sold until it settles, and an answer asked under
/// an older one is dropped.
///
/// **Whose a purchase is.** Each customer has one `appAccountToken` for
/// good (`token(for:)`), which the App Store keeps on the purchase and every
/// renewal, and this install remembers which customer each token is for,
/// with no expiry. A transaction is posted for its token's customer,
/// whoever is signed in by then, and finished only once RevenueCat has
/// taken it (RevenueCat's SDK also finishes on a 4xx; this doesn't). One
/// with no token, or one this install doesn't know, is left alone for
/// Restore. A chain Restore moved to a customer stays theirs. One store
/// sheet at a time.
@MainActor
public final class Subscription {
    /// Why nothing is on sale, when something stands in its way.
    public enum Problem: Equatable, Sendable {
        /// The build has no RevenueCat key, or no store.
        case unconfigured
        /// RevenueCat's current offering has no monthly package, or the store doesn't sell it monthly.
        case noProduct
        /// RevenueCat or the store couldn't be reached; tried again at the next launch or foreground.
        case unreached
        /// RevenueCat refused: 401 and 403 are the key, never retried at once.
        case refused(status: Int)
        /// The store holds a purchase RevenueCat hasn't taken yet: nothing sold, nothing granted.
        case unconfirmed
    }

    public enum PurchaseResult: Equatable, Sendable {
        case purchased
        /// Ask to Buy, or a payment to sort out: it comes later, still the buyer's.
        case pending
        case cancelled
        case failed
        /// Bought, but RevenueCat hasn't taken it yet: tried again at the next foreground.
        case unconfirmed
        /// Nothing on sale, or a store sheet is already open.
        case unavailable
    }

    public enum RestoreResult: Equatable, Sendable {
        case restored
        case nothingFound
        case failed
    }

    /// A Happy account as voice's subscription knows it: its id here and its subject.
    public struct Account: Codable, Equatable, Sendable {
        public var id: String
        public var subject: String

        public init(id: String, subject: String) {
            self.id = id
            self.subject = subject
        }
    }

    public static let anonymousPrefix = "$RCAnonymousID:"

    private enum Key {
        static let install = "subscription.install"
        static let customer = "subscription.customer"
        static let postedByInstall = "subscription.posted-by-install"
        static let tokens = "subscription.tokens"
        static let restored = "subscription.restored"
        static let posted = "subscription.posted"
        static let account = "subscription.account"
    }

    private let store: (any SubscriptionStore)?
    private let revenueCat: (any RevenueCatAPI)?
    private let defaults: any KeyValueStore
    private let now: () -> Double
    private let cache: ProPassCache
    private let work = SerialWork()
    /// Bumped by every customer change, at once.
    public private(set) var generation = 0
    private var told = false
    private var relay: String?
    private var changing = false
    private var monthly: StoreProduct?
    /// Whether the store holds a purchase RevenueCat hasn't taken yet; nothing is sold meanwhile.
    public private(set) var unconfirmed = false
    private var purchasing = false
    private var listening: Task<Void, Never>?
    private var observers: [UUID: @MainActor () -> Void] = [:]
    public private(set) var problem: Problem?

    public init(store: (any SubscriptionStore)?, revenueCat: (any RevenueCatAPI)?, defaults: any KeyValueStore, now: @escaping () -> Double = { Date().timeIntervalSince1970 }) {
        self.store = store
        self.revenueCat = revenueCat
        self.defaults = defaults
        self.now = now
        cache = ProPassCache(store: defaults)
        problem = store == nil || revenueCat == nil ? .unconfigured : nil
    }

    // MARK: What it says

    /// Whose subscription this is now.
    public var customer: String { defaults.string(forKey: Key.customer) ?? install }

    /// Whether the customer has `pro` now, as RevenueCat last said within a
    /// day: any product that grants it, whatever is on sale. False while the
    /// customer changes.
    public var hasPro: Bool { settled && cache.active(customer: customer, now: now()) }

    /// The month of 5 hours the customer has now; nil without `pro`, or
    /// when RevenueCat hasn't said within a day. The meter's window.
    public func month() -> ProMonth? { settled ? cache.month(customer: customer, now: now()) : nil }

    /// What the sheets offer.
    public var offer: CallOffer {
        guard store != nil, revenueCat != nil, settled else { return .unavailable }
        if hasPro { return .subscribed }
        if unconfirmed { return .unavailable }
        return monthly.map { .onSale(price: $0.displayPrice) } ?? .unavailable
    }

    /// Told of every change to what it says, on the main actor, until the token goes.
    public func observe(_ handler: @escaping @MainActor () -> Void) -> SubscriptionObservation {
        let id = UUID()
        observers[id] = handler
        return SubscriptionObservation { [weak self] in self?.observers[id] = nil }
    }

    // MARK: What changes it

    /// Launch: listens to the store from now on, and finishes what it left.
    public func launch() {
        guard listening == nil, let store else { return }
        listening = Task { [weak self] in
            for await transaction in store.updates() {
                guard let self else { return }
                await self.delivered(transaction)
            }
        }
        refresh()
    }

    /// The accounts now: the Happy account in front, if one is, and which
    /// are signed in. While an agent connection is in front the account
    /// in front before it stays the customer, as long as it is signed in
    /// here: voice is used on agent connections, so opening one never
    /// changes whose subscription it is.
    public func accounts(active: Account?, signedIn: Set<String>) {
        var account = active
        if account == nil, let text = defaults.string(forKey: Key.account),
           let last = try? JSONDecoder().decode(Account.self, from: Data(text.utf8)), signedIn.contains(last.id) {
            account = last
        }
        defaults.set(account.flatMap { try? JSONEncoder().encode($0) }.flatMap { String(data: $0, encoding: .utf8) }, forKey: Key.account)
        relay(account?.subject)
    }

    /// The relay customer now, by its subject; nil for none. Whatever was
    /// being asked for the one before is dropped at once. Another account
    /// is switched to, never merged into; signing out starts a new install
    /// customer.
    public func relay(_ subject: String?) {
        if told, relay == subject { return }
        let stored = defaults.string(forKey: Key.customer)
        let previous = told ? relay : stored
        told = true
        relay = subject
        generation += 1
        let asked = generation
        // Launch, with the customer as it was: what RevenueCat said within the day still holds.
        changing = previous != subject || stored != subject
        if changing { cache.clear() }
        notify()
        work.enqueue {
            if subject == nil, self.defaults.string(forKey: Key.customer) != nil {
                // Whatever the account was brought together with stays the account's.
                self.retireInstall()
                self.defaults.set(nil, forKey: Key.customer)
            }
            await self.refreshing()
            if asked == self.generation { self.changing = false }
            self.notify()
        }
    }

    /// Launch and foreground: what's on sale, what the store left
    /// unfinished, and what RevenueCat says now.
    public func refresh() {
        work.enqueue { await self.refreshing() }
    }

    /// The store's sheet for the monthly subscription, for the customer it
    /// opens for: what comes of it is that customer's, whoever is signed in
    /// by then.
    public func buy() async -> PurchaseResult {
        guard let store, !purchasing, case .onSale = offer, let product = monthly else { return .unavailable }
        purchasing = true
        defer { purchasing = false }
        let token = token(for: customer)
        switch await store.purchase(product.id, token: token) {
        case .purchased(let transaction):
            return await work.run {
                guard let owner = self.owner(of: transaction) else { return .failed }
                let posted = await self.post(transaction, for: owner, restore: false, source: .purchase, asked: self.generation)
                if !posted { self.unconfirmed = true }
                self.notify()
                return posted ? .purchased : .unconfirmed
            }
        case .pending: return .pending
        case .cancelled: return .cancelled
        case .failed: return .failed
        }
    }

    /// Restore, on the person's tap only: the store brought up to date,
    /// then everything the App Store account holds posted again as a
    /// restore for the customer now, whatever is on sale and whoever it was
    /// bought by; a chain RevenueCat takes is this customer's from then on.
    public func restore() async -> RestoreResult {
        await work.run {
            guard let store = self.store, let revenueCat = self.revenueCat, await self.settle() else { return .failed }
            let asked = self.generation
            let customer = self.customer
            _ = await store.sync()
            var transactions = await store.entitlements()
            for transaction in await store.unfinished() where !transactions.contains(where: { $0.id == transaction.id }) {
                transactions.append(transaction)
            }
            var failed = false
            var moved: [String] = []
            for transaction in transactions {
                guard asked == self.generation else { return .failed }
                if await self.post(transaction, for: customer, restore: true, source: .restore, asked: asked) {
                    moved.append(transaction.originalID)
                } else {
                    failed = true
                }
            }
            let answer = await revenueCat.subscriber(customer: customer)
            guard asked == self.generation else { return .failed }
            // Only a chain RevenueCat took, for the customer still in front.
            var restored = self.restoredOwners()
            for id in moved { restored[id] = customer }
            self.write(restored, forKey: Key.restored)
            self.take(answer, for: customer, asked: asked)
            self.unconfirmed = failed
            self.notify()
            if self.hasPro { return .restored }
            guard case .ok = answer, !failed else { return .failed }
            return .nothingFound
        }
    }

    /// Once everything asked before this has been done: for the tests.
    func idle() async {
        await work.run {}
    }

    // MARK: Inside

    private var settled: Bool {
        guard !changing, told else { return false }
        return relay == nil || defaults.string(forKey: Key.customer) == relay
    }

    private func refreshing() async {
        guard let store, let revenueCat else { return notify() }
        // Whatever the store left is its owner's, whoever is in front.
        var failed = false
        for transaction in await store.unfinished() {
            guard let owner = owner(of: transaction) else { continue }
            if !(await post(transaction, for: owner, restore: false, source: .queue, asked: generation)) { failed = true }
        }
        unconfirmed = failed
        guard told, await settle() else { return notify() }
        let asked = generation
        let customer = customer
        problem = nil
        let offerings = await revenueCat.offerings(customer: customer)
        var found: StoreProduct?
        switch offerings {
        case .ok(let json):
            if let id = RevenueCatClient.monthlyProduct(json) {
                switch await store.product(id) {
                case .found(let product): found = product
                case .missing: problem = .noProduct
                case .unreached: problem = .unreached
                }
            } else {
                problem = .noProduct
            }
        default: trouble(offerings)
        }
        guard asked == generation else { return }
        monthly = found
        let answer = await revenueCat.subscriber(customer: customer)
        guard asked == generation else { return }
        take(answer, for: customer, asked: asked)
        if unconfirmed { problem = .unconfirmed }
        notify()
    }

    /// What the store sent while the app runs: posted for its owner, if it has one here.
    private func delivered(_ transaction: StoreTransaction) async {
        await work.run {
            guard let owner = self.owner(of: transaction) else { return }
            if !(await self.post(transaction, for: owner, restore: false, source: .queue, asked: self.generation)) {
                self.unconfirmed = true
                self.problem = .unconfirmed
            }
            self.notify()
        }
    }

    /// Posts `transaction` for `owner`, finishes it once RevenueCat has it,
    /// and keeps RevenueCat's answer only for the customer in front in
    /// generation `asked`. A transaction posted before is only finished,
    /// unless restoring.
    private func post(_ transaction: StoreTransaction, for owner: String, restore: Bool, source: RevenueCatReceipt.Source, asked: Int) async -> Bool {
        guard let store, let revenueCat else { return false }
        let mark = Self.hash(transaction.id)
        var posted = readStrings(Key.posted)
        if !restore, posted.contains(mark) {
            await store.finish(transaction)
            return true
        }
        let receipt = RevenueCatReceipt(customer: owner, jws: transaction.jws, productID: transaction.productID, transactionID: transaction.id,
                                        appTransaction: await store.appTransaction(), restore: restore, source: source)
        let answer = await revenueCat.post(receipt)
        guard case .ok = answer else {
            trouble(answer)
            return false
        }
        posted.removeAll { $0 == mark }
        posted.append(mark)
        write(Array(posted.suffix(500)), forKey: Key.posted)
        if owner == install, defaults.string(forKey: Key.customer) == nil { defaults.set("1", forKey: Key.postedByInstall) }
        await store.finish(transaction)
        if owner == customer { take(answer, for: owner, asked: asked) }
        return true
    }

    /// RevenueCat's answer kept for `customer`, if it is still the one in
    /// front in generation `asked`.
    private func take(_ answer: RevenueCatAnswer, for customer: String, asked: Int) {
        guard asked == generation, customer == self.customer else { return }
        guard case .ok(let json) = answer else { return trouble(answer) }
        guard let read = ProPass.answer(json) else { return }
        let pass: ProPass? = if case .pro(let pass) = read { pass } else { nil }
        cache.save(customer: customer, pass: pass, now: now())
    }

    /// Brings the customer to the relay account. What the install bought is
    /// brought into it first (`identify`); until that is done nothing is
    /// sold or granted under either. False while it isn't.
    private func settle() async -> Bool {
        guard let relay else { return true }
        if defaults.string(forKey: Key.customer) == relay { return true }
        if defaults.string(forKey: Key.customer) == nil, defaults.string(forKey: Key.postedByInstall) != nil {
            guard let revenueCat else { return false }
            let asked = generation
            let answer = await revenueCat.identify(from: install, to: relay)
            // Brought together, whatever happened here meanwhile: the install's id is the account's now.
            if case .ok = answer { retireInstall() }
            guard asked == generation else { return false }
            guard case .ok = answer else {
                trouble(answer)
                return false
            }
        }
        defaults.set(relay, forKey: Key.customer)
        defaults.set(nil, forKey: Key.postedByInstall)
        return true
    }

    private func trouble(_ answer: RevenueCatAnswer) {
        switch answer {
        case .refused(let status, _): problem = .refused(status: status)
        case .unreached: problem = .unreached
        case .ok: break
        }
    }

    private func notify() {
        for handler in observers.values { handler() }
    }

    // MARK: Identity

    private var install: String {
        defaults.string(forKey: Key.install) ?? retireInstall()
    }

    /// A new anonymous install customer, as RevenueCat's SDK makes them.
    @discardableResult
    private func retireInstall() -> String {
        let id = Self.anonymousPrefix + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        defaults.set(id, forKey: Key.install)
        defaults.set(nil, forKey: Key.postedByInstall)
        return id
    }

    /// `customer`'s `appAccountToken`, the same for good, remembered as
    /// theirs: SHA-256 of the id, its first 16 bytes with RFC 4122's
    /// name-based version and variant. RevenueCat's SDK passes the id
    /// itself when it is a UUID; these never are.
    public func token(for customer: String) -> UUID {
        let token = Self.token(customer)
        var tokens = readMap(Key.tokens)
        if tokens[token.uuidString] != customer {
            tokens[token.uuidString] = customer
            write(tokens, forKey: Key.tokens)
        }
        return token
    }

    static func token(_ customer: String) -> UUID {
        var bytes = [UInt8](Hashing.sha256(Data(customer.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x50
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                           bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    /// Whose `transaction` is: the customer Restore moved its chain to, or
    /// its token's; nil for one this install never sold.
    private func owner(of transaction: StoreTransaction) -> String? {
        restoredOwners()[transaction.originalID] ?? transaction.token.flatMap { readMap(Key.tokens)[$0.uuidString] }
    }

    private func restoredOwners() -> [String: String] { readMap(Key.restored) }

    private static func hash(_ text: String) -> String {
        Hashing.sha256(Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func readMap(_ key: String) -> [String: String] {
        defaults.string(forKey: key).flatMap { try? JSONDecoder().decode([String: String].self, from: Data($0.utf8)) } ?? [:]
    }

    private func readStrings(_ key: String) -> [String] {
        defaults.string(forKey: key).flatMap { try? JSONDecoder().decode([String].self, from: Data($0.utf8)) } ?? []
    }

    private func write<Value: Encodable>(_ value: Value, forKey key: String) {
        defaults.set((try? JSONEncoder().encode(value)).flatMap { String(data: $0, encoding: .utf8) }, forKey: key)
    }
}

/// Keeps a `Subscription.observe` handler; released or cancelled, it hears no more.
@MainActor
public final class SubscriptionObservation {
    private var cancel: (() -> Void)?

    init(_ cancel: @escaping () -> Void) { self.cancel = cancel }

    public func invalidate() {
        cancel?()
        cancel = nil
    }

    isolated deinit { invalidate() }
}

/// Runs its work one at a time, in the order it was asked for.
@MainActor
final class SerialWork {
    private var tail: Task<Void, Never>?

    /// `body` after everything asked before it; asked for at once, before this returns.
    @discardableResult
    func enqueue<Value: Sendable>(_ body: @escaping @MainActor () async -> Value) -> Task<Value, Never> {
        let previous = tail
        let task = Task { @MainActor in
            await previous?.value
            return await body()
        }
        tail = Task { _ = await task.value }
        return task
    }

    func run<Value: Sendable>(_ body: @escaping @MainActor () async -> Value) async -> Value {
        await enqueue(body).value
    }
}
