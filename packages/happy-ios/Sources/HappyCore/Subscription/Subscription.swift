import Foundation
import HappyCrypto
import HappyWire

/// The app's one subscription: RevenueCat's `pro`, bought through the App
/// Store (`SubscriptionStore`) and told to RevenueCat's REST API
/// (`RevenueCatAPI`), without its SDK. Everything that sells it or asks
/// about it asks here: voice's sheets and hours, the relay's voice, Support
/// us, Settings.
///
/// **Whose it is.** This install's own anonymous customer
/// (`$RCAnonymousID:` and 32 hex digits, as RevenueCat's SDK makes them),
/// kept on the phone and never told to anyone but RevenueCat: not the
/// Happy account, not analytics. No account, signed in or out, changes it.
///
/// **Every phone on the Apple ID.** A purchase carries its customer
/// readably: its `appAccountToken` is the customer's 32 hex digits as a
/// UUID (`token(_:)`, `customer(_:)`), kept on the purchase and every
/// renewal. At launch and foreground, an active subscription on the App
/// Store account that names a customer makes that customer this install's
/// (`adopt`): nothing is restored or moved in RevenueCat, so phones never
/// pull a subscription from each other.
///
/// **Access** is only what RevenueCat says, kept a day at most
/// (`ProPassCache`). Everything that asks RevenueCat or the store runs one
/// at a time, and each customer change starts a new generation at once:
/// nothing is granted until RevenueCat answers for the new customer, and an
/// answer asked under an older one is dropped.
///
/// **Whose a purchase is.** A transaction is posted for the customer its
/// token names, or the one Restore moved its chain to, and finished only
/// once RevenueCat has taken it (RevenueCat's SDK also finishes on a 4xx;
/// this doesn't). One that names no one is left alone. One store sheet at
/// a time.
///
/// **Restore** is the person's tap, with one exception: the first time
/// RevenueCat answers after this version is installed, a subscription the
/// App Store account holds that names no customer (bought before purchases
/// named theirs) is restored once to this install, if it hasn't `pro`
/// (`migrate`).
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

    public static let anonymousPrefix = "$RCAnonymousID:"

    private enum Key {
        static let install = "subscription.install"
        static let restored = "subscription.restored"
        static let posted = "subscription.posted"
        static let migrated = "subscription.migrated"
        /// Earlier versions', when the Happy account could be the customer: cleared, never read.
        static let retired = ["subscription.customer", "subscription.posted-by-install", "subscription.tokens", "subscription.account"]
    }

    private let store: (any SubscriptionStore)?
    private let revenueCat: (any RevenueCatAPI)?
    private let defaults: any KeyValueStore
    private let now: () -> Double
    private let cache: ProPassCache
    private let work = SerialWork()
    /// Bumped by every customer change, at once.
    public private(set) var generation = 0
    private var monthly: StoreProduct?
    /// Whether the store holds a purchase RevenueCat hasn't taken yet; nothing is sold meanwhile.
    public private(set) var unconfirmed = false
    private var purchasing = false
    private var listening: Task<Void, Never>?
    private var observers: [UUID: @MainActor () -> Void] = [:]
    public private(set) var problem: Problem?
    /// The build grants `pro` itself (`AppVariant.grantsPro`): everything
    /// that asks sees a subscriber, with a subscriber's hours in each
    /// calendar month (`ProMonth.calendar`). Nothing is sold or restored.
    public let grantsPro: Bool

    public init(store: (any SubscriptionStore)?, revenueCat: (any RevenueCatAPI)?, defaults: any KeyValueStore, grantsPro: Bool = false,
                now: @escaping () -> Double = { Date().timeIntervalSince1970 }) {
        self.store = store
        self.revenueCat = revenueCat
        self.grantsPro = grantsPro
        self.defaults = defaults
        self.now = now
        cache = ProPassCache(store: defaults)
        problem = store == nil || revenueCat == nil ? .unconfigured : nil
        for key in Key.retired { defaults.set(nil, forKey: key) }
    }

    // MARK: What it says

    /// Whose subscription this is: this install's customer, made at its first ask.
    public var customer: String {
        if let id = defaults.string(forKey: Key.install), Self.token(id) != nil { return id }
        let id = Self.anonymousPrefix + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        defaults.set(id, forKey: Key.install)
        return id
    }

    /// Whether the customer has `pro` now, as RevenueCat last said within a
    /// day: any product that grants it, whatever is on sale.
    public var hasPro: Bool { grantsPro || cache.active(customer: customer, now: now()) }

    /// The month of 2 hours the customer has now; nil without `pro`, or
    /// when RevenueCat hasn't said within a day. The meter's window.
    public func month() -> ProMonth? { grantsPro ? .calendar(at: now()) : cache.month(customer: customer, now: now()) }

    /// What the sheets offer.
    public var offer: CallOffer {
        if grantsPro { return .subscribed }
        guard store != nil, revenueCat != nil else { return .unavailable }
        if hasPro { return .subscribed }
        if unconfirmed { return .unavailable }
        return monthly.map { .onSale(price: $0.displayPrice) } ?? .unavailable
    }

    /// What the customer pays a month, as the store words it: the monthly
    /// product's price, when that is the product granting `pro`; nil for any
    /// other, or while that isn't known.
    public var subscribedPrice: String? {
        guard hasPro, let monthly, cache.pass(customer: customer, now: now())?.pass?.product == monthly.id else { return nil }
        return monthly.displayPrice
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

    /// Launch and foreground: what the store left unfinished, whose
    /// subscription the App Store account holds, what's on sale, and what
    /// RevenueCat says now.
    public func refresh() {
        work.enqueue { await self.refreshing() }
    }

    /// The store's sheet for the monthly subscription, for the customer it
    /// opens for: what comes of it is that customer's.
    public func buy() async -> PurchaseResult {
        guard let store, !purchasing, case .onSale = offer, let product = monthly, let token = Self.token(customer) else { return .unavailable }
        purchasing = true
        defer { purchasing = false }
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

    /// Restore, on the person's tap: the store brought up to date, its
    /// customer adopted as at launch, then everything the App Store account
    /// holds posted again as a restore for the customer now, whatever is on
    /// sale and whoever it was bought by; a chain RevenueCat takes is this
    /// customer's from then on.
    public func restore() async -> RestoreResult {
        await work.run {
            guard let store = self.store, let revenueCat = self.revenueCat else { return .failed }
            _ = await store.sync()
            var transactions = await store.entitlements()
            self.adopt(transactions)
            let asked = self.generation
            let customer = self.customer
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
            self.moved(moved, to: customer)
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

    private func refreshing() async {
        guard let store, let revenueCat else { return notify() }
        // Whatever the store left is its owner's.
        var failed = false
        for transaction in await store.unfinished() {
            guard let owner = owner(of: transaction) else { continue }
            if !(await post(transaction, for: owner, restore: false, source: .queue, asked: generation)) { failed = true }
        }
        unconfirmed = failed
        let entitlements = await store.entitlements()
        adopt(entitlements)
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
        if case .ok = answer { await migrate(entitlements, for: customer, asked: asked) }
        if unconfirmed { problem = .unconfirmed }
        notify()
    }

    /// What the store sent while the app runs: posted for its owner, if it has one.
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

    /// The customer an active subscription on the App Store account names,
    /// made this install's when none of them is already: bought on another
    /// phone with the same Apple ID, or by this install before a reinstall.
    /// Nothing is posted; RevenueCat already has it under that customer.
    private func adopt(_ entitlements: [StoreTransaction]) {
        let customer = customer
        let restored = restoredOwners()
        let named = entitlements.compactMap { $0.token.flatMap(Self.customer) }
        guard let adopted = named.first, !named.contains(customer),
              !entitlements.contains(where: { restored[$0.originalID] == customer }) else { return }
        defaults.set(adopted, forKey: Key.install)
        generation += 1
        notify()
    }

    /// The one restore this version makes by itself: the first time
    /// RevenueCat answers for this install without `pro`, every subscription
    /// the App Store account holds that names no customer is posted as a
    /// restore for it. Done once RevenueCat has taken them all, or when
    /// there was nothing to take; tried again at the next launch or
    /// foreground until then.
    private func migrate(_ entitlements: [StoreTransaction], for customer: String, asked: Int) async {
        guard defaults.string(forKey: Key.migrated) == nil else { return }
        var failed = false
        if !hasPro {
            var moved: [String] = []
            for transaction in entitlements where transaction.token.flatMap(Self.customer) == nil {
                guard asked == generation else { return }
                if await post(transaction, for: customer, restore: true, source: .restore, asked: asked) {
                    moved.append(transaction.originalID)
                } else {
                    failed = true
                }
            }
            guard asked == generation else { return }
            self.moved(moved, to: customer)
        }
        if !failed { defaults.set("1", forKey: Key.migrated) }
    }

    /// The chains RevenueCat took as restored for `customer`: theirs from then on.
    private func moved(_ chains: [String], to customer: String) {
        guard !chains.isEmpty else { return }
        var restored = restoredOwners()
        for id in chains { restored[id] = customer }
        write(restored, forKey: Key.restored)
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

    /// `customer`'s `appAccountToken`: its 32 hex digits as a UUID, which
    /// reads back as the customer on any phone (`customer(_:)`). Nil for an
    /// id that isn't an install's.
    static func token(_ customer: String) -> UUID? {
        guard customer.hasPrefix(anonymousPrefix) else { return nil }
        let hex = Array(customer.dropFirst(anonymousPrefix.count))
        guard hex.count == 32 else { return nil }
        let text = [0..<8, 8..<12, 12..<16, 16..<20, 20..<32].map { String(hex[$0]) }.joined(separator: "-")
        guard let token = UUID(uuidString: text), Self.customer(token) == customer else { return nil }
        return token
    }

    /// The customer a purchase's `appAccountToken` names; nil for none. An
    /// install's id is a random UUID's hex, version 4; the tokens earlier
    /// versions bought with were SHA-256 of a customer id (version 5), and
    /// name no one.
    static func customer(_ token: UUID) -> String? {
        let hex = Array(token.uuidString.replacingOccurrences(of: "-", with: "").lowercased())
        guard hex[12] == "4", "89ab".contains(hex[16]) else { return nil }
        return anonymousPrefix + String(hex)
    }

    /// The `appAccountToken` earlier versions bought with for `customer`:
    /// SHA-256 of its id, its first 16 bytes with RFC 4122's name-based
    /// version and variant. Read only as this install's own.
    static func legacyToken(_ customer: String) -> UUID {
        var bytes = [UInt8](Hashing.sha256(Data(customer.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x50
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                           bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    /// Whose `transaction` is: the customer Restore moved its chain to, or
    /// the one its token names (an earlier version's, this install's own);
    /// nil for one that names no one.
    private func owner(of transaction: StoreTransaction) -> String? {
        if let owner = restoredOwners()[transaction.originalID] { return owner }
        guard let token = transaction.token else { return nil }
        if let named = Self.customer(token) { return named }
        let customer = customer
        return token == Self.legacyToken(customer) ? customer : nil
    }

    /// The chains Restore moved, and to whom; one moved to a Happy account by an earlier version is no one's.
    private func restoredOwners() -> [String: String] { readMap(Key.restored).filter { Self.token($0.value) != nil } }

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
///
/// Not `isolated deinit`, for the reason HappyUI's `Watch` gives: on iOS
/// 26 the runtime's hop to the actor aborts in libmalloc ("pointer being
/// freed was not allocated", under `TaskLocal::StopLookupScope`) when a
/// screen holding one is freed, and an iPhone 12 on 26.1 does it too.
@MainActor
public final class SubscriptionObservation {
    private var cancel: (@MainActor @Sendable () -> Void)?

    init(_ cancel: @escaping @MainActor @Sendable () -> Void) { self.cancel = cancel }

    public func invalidate() {
        let cancel = cancel
        self.cancel = nil
        cancel?()
    }

    /// Nonisolated, and the only thing left holding the object; the cancel
    /// is `Sendable` and main-actor, so it is run there.
    deinit {
        guard let cancel else { return }
        if Thread.isMainThread {
            MainActor.assumeIsolated { cancel() }
        } else {
            DispatchQueue.main.async { cancel() }
        }
    }
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
