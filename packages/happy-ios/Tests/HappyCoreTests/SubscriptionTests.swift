import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// The one subscription owner (`Subscription`) with the App Store and
/// RevenueCat faked: whose a purchase is, when it is posted and finished,
/// the install's one customer and the one an App Store account's
/// subscription names, the one restore a new version makes, restore, and
/// what is on sale.
@MainActor
final class SubscriptionTests: XCTestCase {
    private var clock = 1_793_000_000.0
    private let defaults = InMemoryKeyValueStore()
    private let store = FakeStore()
    private let revenueCat = FakeRevenueCat()
    /// Another phone's install on the same Apple ID.
    private let other = "$RCAnonymousID:0123456789ab4def8123456789abcdef"

    override func setUp() {
        super.setUp()
        // The one restore a new version makes is its own tests'.
        defaults.set("1", forKey: "subscription.migrated")
    }

    private func owner() -> Subscription {
        Subscription(store: store, revenueCat: revenueCat, defaults: defaults, now: { [unowned self] in clock })
    }

    /// This install's customer, as the next owner will know it.
    private var install: String { owner().customer }

    /// An owner launched or refreshed once, settled.
    private func ready(launch: Bool = false) async -> Subscription {
        let subscription = owner()
        if launch { subscription.launch() } else { subscription.refresh() }
        await subscription.idle()
        return subscription
    }

    private func assertEqual<T: Equatable>(_ value: T, _ expected: T, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(value, expected, file: file, line: line)
    }

    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<500 where !condition() { try? await Task.sleep(for: .milliseconds(2)) }
    }

    private func transaction(_ id: String, token: UUID?, original: String? = nil) -> StoreTransaction {
        StoreTransaction(id: id, originalID: original ?? id, productID: "happy_monthly", jws: "jws.\(id)", token: token)
    }

    private func token(_ customer: String) -> UUID {
        Subscription.token(customer)!
    }

    // MARK: The preview app

    /// The preview app is a subscriber from its build alone: voice opens with no welcome, a subscriber's 5 hours
    /// in each calendar month, and nothing sold.
    func testThePreviewBuildIsASubscriber() async throws {
        XCTAssertEqual(AppVariant.allCases.filter(\.grantsPro), [.preview])
        let subscription = Subscription(store: nil, revenueCat: nil, defaults: defaults, grantsPro: true, now: { [unowned self] in clock })
        subscription.refresh()
        await subscription.idle()
        XCTAssertTrue(subscription.hasPro)
        XCTAssertEqual(subscription.offer, .subscribed)
        let month = try XCTUnwrap(subscription.month())
        XCTAssertEqual(month, ProMonth.calendar(at: clock))
        XCTAssertLessThanOrEqual(month.start, clock)
        XCTAssertGreaterThan(try XCTUnwrap(month.end), clock)
        assertEqual(await subscription.buy(), .unavailable)
        XCTAssertEqual(CallAllowance(store: MemoryCallUsage(), period: { subscription.month() }).remaining(at: clock), CallAllowance.paidSeconds)
        XCTAssertFalse(CallIntro(defaults: UserDefaults(suiteName: "preview-\(UUID())")!).welcomes(subscription.offer))
    }

    /// A store build is unchanged: without RevenueCat's `pro` it sells, welcomes and counts the free 20 minutes.
    func testAStoreBuildIsNotASubscriberUntilItBuys() async {
        let subscription = await ready()
        XCTAssertFalse(subscription.grantsPro)
        XCTAssertFalse(subscription.hasPro)
        XCTAssertNil(subscription.month())
        XCTAssertEqual(subscription.offer, .onSale(price: "$19.99"))
        XCTAssertEqual(CallAllowance(store: MemoryCallUsage(), period: { subscription.month() }).remaining(at: clock), CallAllowance.freeSeconds)
        XCTAssertTrue(CallIntro(defaults: UserDefaults(suiteName: "store-\(UUID())")!).welcomes(subscription.offer))
    }

    // MARK: On sale

    func testWithoutAKeyNothingIsSoldAndNothingIsAsked() async {
        let subscription = Subscription(store: nil, revenueCat: nil, defaults: defaults)
        subscription.refresh()
        await subscription.idle()
        XCTAssertEqual(subscription.offer, .unavailable)
        XCTAssertEqual(subscription.problem, .unconfigured)
        assertEqual(await subscription.buy(), .unavailable)
        XCTAssertNil(RevenueCatClient.key(""))
        XCTAssertNil(RevenueCatClient.key("$(HAPPY_REVENUE_CAT_APPLE_KEY)"))
        XCTAssertEqual(RevenueCatClient.key(" appl_x "), "appl_x")
    }

    func testTheCurrentMonthlyPackageIsOnSaleAtTheStoresPrice() async {
        let subscription = await ready()
        XCTAssertEqual(subscription.offer, .onSale(price: "$19.99"))
        XCTAssertNil(subscription.problem)
        // No monthly package, or the store doesn't sell it monthly: nothing.
        revenueCat.offerings = FakeRevenueCat.offerings(product: nil)
        subscription.refresh()
        await subscription.idle()
        XCTAssertEqual(subscription.offer, .unavailable)
        XCTAssertEqual(subscription.problem, .noProduct)
        revenueCat.offerings = FakeRevenueCat.offerings(product: "happy_yearly")
        subscription.refresh()
        await subscription.idle()
        XCTAssertEqual(subscription.problem, .noProduct)
    }

    func testAKeyRevenueCatRefusesIsSaidAndNotRetriedAtOnce() async {
        revenueCat.refuse = 401
        let subscription = await ready()
        XCTAssertEqual(subscription.offer, .unavailable)
        XCTAssertEqual(subscription.problem, .refused(status: 401))
        XCTAssertEqual(revenueCat.calls.filter { $0.hasPrefix("offerings") }.count, 1)
    }

    func testAnExistingProOfAnyProductSellsNothing() async {
        revenueCat.grant(install, product: "happy_lifetime", expires: nil, at: clock)
        let subscription = await ready()
        XCTAssertTrue(subscription.hasPro)
        XCTAssertEqual(subscription.offer, .subscribed)
        XCTAssertNil(subscription.subscribedPrice, "a lifetime pro is said at the monthly price")
        assertEqual(await subscription.buy(), .unavailable)
        XCTAssertTrue(store.purchases.isEmpty)
    }

    /// Relaunched offline: what RevenueCat said within the day holds from
    /// the first moment; a day later it is unknown and grants nothing.
    func testALaunchKeepsTheDaysAnswer() async {
        revenueCat.grant(install, expires: clock + 20 * 86_400, at: clock)
        _ = await ready()
        revenueCat.unreachable = true
        clock += 3600
        let again = owner()
        XCTAssertTrue(again.hasPro, "pro waited for RevenueCat at launch")
        again.refresh()
        await again.idle()
        XCTAssertTrue(again.hasPro)
        clock += 86_400
        XCTAssertFalse(again.hasPro)
    }

    // MARK: Buying

    func testAPurchaseIsPostedForItsBuyerAndFinishedOnlyOnceTaken() async throws {
        let subscription = await ready()
        store.next = .bought
        assertEqual(await subscription.buy(), .purchased)
        let bought = try XCTUnwrap(store.purchases.first)
        // The purchase names its buyer readably: any phone on the Apple ID reads it back.
        XCTAssertEqual(bought.token, token(subscription.customer))
        XCTAssertEqual(bought.token.flatMap(Subscription.customer), subscription.customer)
        XCTAssertEqual(revenueCat.posted.map(\.customer), [subscription.customer])
        let receipt = try XCTUnwrap(revenueCat.posted.first)
        XCTAssertEqual(receipt.jws, "jws.\(bought.id)")
        XCTAssertEqual(receipt.source, .purchase)
        XCTAssertFalse(receipt.restore)
        XCTAssertEqual(receipt.appTransaction, "app.jws")
        XCTAssertEqual(store.finished, [bought.id])
        XCTAssertTrue(subscription.hasPro)
        XCTAssertEqual(subscription.offer, .subscribed)
        XCTAssertEqual(subscription.subscribedPrice, "$19.99")
    }

    func testAPurchaseRevenueCatDidntTakeStaysUnfinishedAndIsPostedAtTheNextForeground() async {
        let subscription = await ready()
        revenueCat.failPosts = 500
        store.next = .bought
        assertEqual(await subscription.buy(), .unconfirmed)
        XCTAssertTrue(store.finished.isEmpty)
        XCTAssertTrue(subscription.unconfirmed)
        XCTAssertEqual(subscription.offer, .unavailable)
        XCTAssertFalse(subscription.hasPro)
        revenueCat.failPosts = nil
        subscription.refresh()
        await subscription.idle()
        XCTAssertFalse(subscription.unconfirmed)
        XCTAssertEqual(revenueCat.posted.map(\.customer), [subscription.customer])
        XCTAssertEqual(revenueCat.posted.last?.source, .queue)
        XCTAssertEqual(store.finished.count, 1)
        XCTAssertTrue(subscription.hasPro)
    }

    /// RevenueCat's SDK finishes on a 4xx; this keeps it for RevenueCat.
    func testARefusedReceiptIsNotFinished() async {
        let subscription = await ready()
        revenueCat.failPosts = 400
        store.next = .bought
        assertEqual(await subscription.buy(), .unconfirmed)
        XCTAssertTrue(store.finished.isEmpty)
        XCTAssertEqual(subscription.problem, .refused(status: 400))
    }

    func testASecondSubscribeWhileTheSheetIsOpenOpensNothing() async {
        let subscription = await ready()
        store.next = .held
        let first = Task { await subscription.buy() }
        await waitFor { store.open }
        assertEqual(await subscription.buy(), .unavailable)
        store.release(.cancelled)
        assertEqual(await first.value, .cancelled)
        XCTAssertEqual(store.purchases.count, 1)
    }

    /// Ask to Buy, approved months later: posted for the customer it names, and granted.
    func testAPendingPurchaseIsItsBuyersHoweverLongItWaits() async {
        let subscription = await ready(launch: true)
        store.next = .pending
        assertEqual(await subscription.buy(), .pending)
        clock += 120 * 86_400
        revenueCat.now = clock
        store.deliver(transaction("late", token: store.purchases[0].token))
        // Finished only once RevenueCat took it: after the post, so wait for the finish.
        await waitFor { store.finished.contains("late") }
        XCTAssertEqual(revenueCat.posted.map(\.customer), [subscription.customer])
        XCTAssertTrue(subscription.hasPro)
    }

    /// A renewal is posted for the customer it names, after a restart too,
    /// and delivered twice it is posted once.
    func testARenewalIsPostedOnceForItsBuyer() async {
        var subscription = await ready(launch: true)
        store.next = .bought
        assertEqual(await subscription.buy(), .purchased)
        let buyer = subscription.customer
        store.deliver(transaction("renewal1", token: token(buyer), original: store.purchases[0].id))
        await waitFor { revenueCat.posted.count == 2 }
        XCTAssertEqual(revenueCat.posted.last?.customer, buyer)
        subscription = owner()
        subscription.launch()
        await subscription.idle()
        let next = transaction("renewal2", token: token(buyer), original: store.purchases[0].id)
        store.deliver(next)
        store.deliver(next)
        await waitFor { store.finished.filter { $0 == "renewal2" }.count == 2 }
        XCTAssertEqual(revenueCat.posted.filter { $0.transactionID == "renewal2" }.map(\.customer), [buyer])
    }

    /// Launch with transactions the store holds: the finished ones are
    /// never posted again; an unfinished one is posted for the customer it
    /// names, this install's own from an earlier version included; one that
    /// names no one is left alone.
    func testTheLaunchSweepPostsWhatNamesACustomerAndLeftUnfinished() async {
        let install = install
        store.unfinishedList = [
            transaction("mine", token: token(install)),
            transaction("legacy", token: Subscription.legacyToken(install)),
            transaction("expired", token: token(other)),
            transaction("foreign", token: Subscription.legacyToken("someone")),
            transaction("none", token: nil),
        ]
        let subscription = await ready(launch: true)
        XCTAssertEqual(revenueCat.posted.map(\.transactionID), ["mine", "legacy", "expired"])
        XCTAssertEqual(revenueCat.posted.map(\.customer), [install, install, other])
        XCTAssertEqual(store.finished, ["mine", "legacy", "expired"])
        // An unfinished transaction isn't a subscription the account holds: nothing adopted.
        XCTAssertEqual(subscription.customer, install)
    }

    // MARK: Another phone on the same Apple ID

    /// The App Store account holds a subscription another phone bought:
    /// its customer is this install's from now on, with no restore and no
    /// receipt, and RevenueCat says it has pro.
    func testASubscriptionNamingAnotherInstallIsAdoptedWithoutARestore() async {
        let mine = install
        store.entitlementList = [transaction("bought-elsewhere", token: token(other))]
        revenueCat.grant(other, expires: clock + 20 * 86_400, at: clock)
        let subscription = await ready(launch: true)
        XCTAssertEqual(subscription.customer, other)
        XCTAssertNotEqual(subscription.customer, mine)
        XCTAssertTrue(subscription.hasPro)
        XCTAssertEqual(subscription.offer, .subscribed)
        XCTAssertTrue(revenueCat.posted.isEmpty, "adopting posted a receipt")
        XCTAssertFalse(store.synced)
        XCTAssertTrue(revenueCat.calls.contains("subscriber \(other)"))
        // Restarted: still the adopted customer.
        XCTAssertEqual(owner().customer, other)
    }

    /// Bought on the other phone while this one runs: adopted at the next
    /// foreground, at once a new generation that grants nothing until
    /// RevenueCat answers for it.
    func testASubscriptionBoughtElsewhereIsAdoptedAtTheNextForeground() async {
        let subscription = await ready(launch: true)
        let mine = subscription.customer
        let generation = subscription.generation
        XCTAssertFalse(subscription.hasPro)
        store.entitlementList = [transaction("bought-elsewhere", token: token(other))]
        revenueCat.grant(other, expires: clock + 20 * 86_400, at: clock)
        subscription.refresh()
        await subscription.idle()
        XCTAssertEqual(revenueCat.calls.suffix(2), ["offerings \(other)", "subscriber \(other)"])
        XCTAssertNotEqual(subscription.customer, mine)
        XCTAssertEqual(subscription.customer, other)
        XCTAssertGreaterThan(subscription.generation, generation)
        XCTAssertTrue(subscription.hasPro)
        XCTAssertTrue(revenueCat.posted.isEmpty)
    }

    /// One of the account's subscriptions is this install's own: it stays,
    /// whatever else the account holds.
    func testAnInstallWhoseOwnSubscriptionIsThereKeepsItsCustomer() async {
        let mine = install
        store.entitlementList = [transaction("elsewhere", token: token(other)), transaction("mine", token: token(mine))]
        let subscription = await ready()
        XCTAssertEqual(subscription.customer, mine)
    }

    /// Only an active subscription is adopted, never one that names no one.
    func testNothingIsAdoptedFromAnUnnamedOrLapsedSubscription() async {
        let mine = install
        store.entitlementList = [transaction("old", token: Subscription.legacyToken(other)), transaction("none", token: nil)]
        let subscription = await ready()
        XCTAssertEqual(subscription.customer, mine)
    }

    // MARK: The one restore a new version makes

    /// The first launch of this version: the account holds a subscription
    /// that names no one (bought by an earlier version, or by happy-app),
    /// and this install hasn't pro: it is posted once as a restore, and its
    /// chain is the install's from then on. Never again by itself.
    func testTheFirstLaunchRestoresAnUnnamedSubscriptionOnce() async throws {
        defaults.set(nil, forKey: "subscription.migrated")
        let install = install
        store.entitlementList = [transaction("hashed", token: Subscription.legacyToken("account-a")), transaction("sdk", token: nil)]
        let subscription = await ready()
        XCTAssertEqual(Set(revenueCat.posted.map(\.transactionID)), ["hashed", "sdk"])
        XCTAssertTrue(revenueCat.posted.allSatisfy { $0.customer == install && $0.restore && $0.source == .restore })
        XCTAssertTrue(subscription.hasPro)
        XCTAssertFalse(store.synced, "it asked the person to sign in to the App Store")
        // Lost in RevenueCat later: nothing restores by itself again, after a restart either.
        revenueCat.revoke(install)
        clock += 2 * 86_400
        revenueCat.now = clock
        subscription.refresh()
        await subscription.idle()
        let again = await ready()
        XCTAssertFalse(again.hasPro)
        XCTAssertEqual(revenueCat.posted.count, 2)
        // Its next renewal is the install's.
        again.launch()
        store.deliver(transaction("renewal", token: nil, original: "sdk"))
        await waitFor { revenueCat.posted.count >= 3 }
        await again.idle()
        XCTAssertEqual(revenueCat.posted.count, 3)
        XCTAssertEqual(revenueCat.posted.last?.customer, install)
        XCTAssertEqual(revenueCat.posted.last?.restore, false)
    }

    func testTheFirstLaunchRestoresNothingWhenTheInstallHasPro() async {
        defaults.set(nil, forKey: "subscription.migrated")
        revenueCat.grant(install, expires: clock + 20 * 86_400, at: clock)
        store.entitlementList = [transaction("sdk", token: nil)]
        _ = await ready()
        XCTAssertTrue(revenueCat.posted.isEmpty)
        // Done: pro lost later restores nothing.
        revenueCat.revoke(install)
        clock += 2 * 86_400
        revenueCat.now = clock
        _ = await ready()
        XCTAssertTrue(revenueCat.posted.isEmpty)
    }

    /// An adopted customer with pro is pro: nothing of the older purchases is restored.
    func testTheFirstLaunchRestoresNothingWhenTheAdoptedCustomerHasPro() async {
        defaults.set(nil, forKey: "subscription.migrated")
        revenueCat.grant(other, expires: clock + 20 * 86_400, at: clock)
        store.entitlementList = [transaction("named", token: token(other)), transaction("sdk", token: nil)]
        let subscription = await ready()
        XCTAssertEqual(subscription.customer, other)
        XCTAssertTrue(revenueCat.posted.isEmpty)
    }

    /// RevenueCat unreached, or not taking the restore: tried again at the
    /// next launch or foreground, until it is done once.
    func testTheFirstLaunchsRestoreWaitsForRevenueCat() async {
        defaults.set(nil, forKey: "subscription.migrated")
        store.entitlementList = [transaction("sdk", token: nil)]
        revenueCat.unreachable = true
        let subscription = await ready()
        XCTAssertTrue(revenueCat.posted.isEmpty)
        revenueCat.unreachable = false
        revenueCat.failPosts = 503
        subscription.refresh()
        await subscription.idle()
        XCTAssertTrue(revenueCat.posted.isEmpty)
        XCTAssertFalse(subscription.hasPro)
        revenueCat.failPosts = nil
        subscription.refresh()
        await subscription.idle()
        XCTAssertEqual(revenueCat.posted.map(\.transactionID), ["sdk"])
        XCTAssertTrue(subscription.hasPro)
        subscription.refresh()
        await subscription.idle()
        XCTAssertEqual(revenueCat.posted.count, 1)
    }

    // MARK: Restore

    func testRestorePostsWhatTheAccountHoldsForTheCustomerNow() async {
        store.entitlementList = [transaction("foreign", token: nil)]
        store.unfinishedList = [transaction("unknown", token: Subscription.legacyToken("someone"))]
        let subscription = await ready()
        XCTAssertTrue(revenueCat.posted.isEmpty)
        assertEqual(await subscription.restore(), .restored)
        XCTAssertTrue(store.synced)
        XCTAssertEqual(Set(revenueCat.posted.map(\.transactionID)), ["foreign", "unknown"])
        XCTAssertTrue(revenueCat.posted.allSatisfy { $0.customer == subscription.customer && $0.restore && $0.source == .restore })
        XCTAssertTrue(store.finished.contains("unknown"))
    }

    /// Restore adopts as a launch does first: a subscription another phone
    /// bought is restored for its own customer, never pulled to this one's.
    func testRestoreAdoptsTheCustomerTheAccountsSubscriptionNamesFirst() async {
        let subscription = await ready()
        store.entitlementList = [transaction("elsewhere", token: token(other))]
        assertEqual(await subscription.restore(), .restored)
        XCTAssertEqual(subscription.customer, other)
        XCTAssertEqual(revenueCat.posted.map(\.customer), [other])
    }

    /// Restore needs the key and the store, never something on sale: an
    /// owned product that is no longer offered (a yearly one, here) is
    /// restored, and Subscribe stays off.
    func testRestoreWithNoMonthlyPackage() async {
        revenueCat.offerings = FakeRevenueCat.offerings(product: nil)
        await restoresWithNothingOnSale()
    }

    func testRestoreWithTheMonthlyProductMissingFromTheStore() async {
        store.productList = [:]
        await restoresWithNothingOnSale()
    }

    private func restoresWithNothingOnSale(file: StaticString = #filePath, line: UInt = #line) async {
        store.entitlementList = [StoreTransaction(id: "y1", originalID: "y0", productID: "happy_yearly", jws: "jws.y1", token: nil)]
        let subscription = await ready()
        XCTAssertEqual(subscription.offer, .unavailable, file: file, line: line)
        XCTAssertEqual(subscription.problem, .noProduct, file: file, line: line)
        assertEqual(await subscription.buy(), .unavailable, file: file, line: line)
        XCTAssertTrue(store.purchases.isEmpty, file: file, line: line)
        assertEqual(await subscription.restore(), .restored, file: file, line: line)
        XCTAssertEqual(revenueCat.posted.map(\.productID), ["happy_yearly"], file: file, line: line)
        XCTAssertTrue(revenueCat.posted.allSatisfy { $0.customer == subscription.customer && $0.restore }, file: file, line: line)
        XCTAssertTrue(subscription.hasPro, file: file, line: line)
        XCTAssertEqual(subscription.offer, .subscribed, file: file, line: line)
    }

    func testRestoreWhilePendingFindsNothing() async {
        let subscription = await ready()
        store.next = .pending
        assertEqual(await subscription.buy(), .pending)
        assertEqual(await subscription.restore(), .nothingFound)
        XCTAssertTrue(revenueCat.posted.isEmpty)
        revenueCat.unreachable = true
        assertEqual(await subscription.restore(), .failed)
    }

    /// A chain that names no one, restored on purpose: the install's from
    /// then on, its renewals posted for it after a restart too.
    func testARestoredChainStaysWithWhoeverRestoredIt() async {
        store.entitlementList = [transaction("old", token: nil)]
        var subscription = await ready()
        assertEqual(await subscription.restore(), .restored)
        let restorer = subscription.customer
        subscription = owner()
        subscription.launch()
        await subscription.idle()
        store.deliver(transaction("renewal", token: nil, original: "old"))
        store.deliver(transaction("stranger", token: nil, original: "another-chain"))
        await waitFor { revenueCat.posted.count == 2 }
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(revenueCat.posted.map(\.transactionID), ["old", "renewal"])
        XCTAssertEqual(revenueCat.posted.last?.customer, restorer)
    }

    // MARK: Identity

    func testTheInstallsCustomerIsAnonymousAndKeptForGood() async {
        let subscription = await ready()
        let install = subscription.customer
        XCTAssertTrue(install.hasPrefix("$RCAnonymousID:"))
        XCTAssertEqual(install.count, "$RCAnonymousID:".count + 32)
        XCTAssertTrue(install.dropFirst("$RCAnonymousID:".count).allSatisfy { "0123456789abcdef".contains($0) })
        XCTAssertEqual(owner().customer, install)
    }

    /// An earlier version's: the Happy account as the customer, the hashed
    /// tokens it bought with, a chain restored to it. None of it is the
    /// subscription's any more, and nothing is posted for the account.
    func testWhatAnEarlierVersionKeptForAHappyAccountIsDropped() async throws {
        let install = install
        defaults.set("account-a", forKey: "subscription.customer")
        defaults.set("1", forKey: "subscription.posted-by-install")
        defaults.set(#"{"\#(Subscription.legacyToken("account-a").uuidString)":"account-a"}"#, forKey: "subscription.tokens")
        defaults.set(#"{"chain":"account-a"}"#, forKey: "subscription.restored")
        defaults.set(#"{"id":"x","subject":"account-a"}"#, forKey: "subscription.account")
        store.unfinishedList = [transaction("bought-as-a", token: Subscription.legacyToken("account-a")), transaction("renewal", token: nil, original: "chain")]
        let subscription = await ready(launch: true)
        XCTAssertEqual(subscription.customer, install)
        XCTAssertTrue(revenueCat.posted.isEmpty)
        XCTAssertFalse(revenueCat.calls.contains { $0.contains("account-a") })
        for key in ["subscription.customer", "subscription.posted-by-install", "subscription.tokens", "subscription.account"] {
            XCTAssertNil(defaults.string(forKey: key), key)
        }
    }

    func testTheTokenIsTheCustomersHexAndReadsBack() throws {
        let customer = "$RCAnonymousID:0123456789ab4def8123456789abcdef"
        let token = try XCTUnwrap(Subscription.token(customer))
        XCTAssertEqual(token.uuidString, "01234567-89AB-4DEF-8123-456789ABCDEF")
        XCTAssertEqual(Subscription.customer(token), customer)
        // Every install's reads back as itself.
        for _ in 0..<50 {
            let fresh = Subscription(store: nil, revenueCat: nil, defaults: InMemoryKeyValueStore()).customer
            XCTAssertEqual(Subscription.token(fresh).flatMap(Subscription.customer), fresh)
        }
        // Not an install's: no token. An earlier version's hashed token names no one.
        XCTAssertNil(Subscription.token("account-a"))
        XCTAssertNil(Subscription.token("$RCAnonymousID:0123456789AB4DEF8123456789ABCDEF"))
        XCTAssertNil(Subscription.token("$RCAnonymousID:0123"))
        XCTAssertNil(Subscription.customer(Subscription.legacyToken(customer)))
        XCTAssertEqual(Array(Subscription.legacyToken(customer).uuidString)[14], "5")
    }

    // MARK: The REST client

    func testTheClientSpeaksRevenueCatsV1() async throws {
        let http = FakeHTTP()
        http.onRaw("GET /v1/subscribers/$RCAnonymousID:abc/offerings", #"{"current_offering_id":"d","offerings":[]}"#)
        http.onRaw("POST /v1/receipts", #"{"request_date":"2026-11-04T10:00:00Z","subscriber":{"entitlements":{}}}"#)
        http.onRaw("GET /v1/subscribers/x", #"{"message":"Invalid API key"}"#, status: 401)
        let client = RevenueCatClient(transport: http, key: "appl_test")
        guard case .ok = await client.offerings(customer: "$RCAnonymousID:abc") else { return XCTFail("offerings") }
        let request = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(request.url.absoluteString, "https://api.revenuecat.com/v1/subscribers/%24RCAnonymousID%3Aabc/offerings")
        XCTAssertEqual(request.headers["Authorization"], "Bearer appl_test")
        XCTAssertEqual(request.headers["X-Platform"], "iOS")
        XCTAssertEqual(request.headers["X-StoreKit2-Enabled"], "true")
        XCTAssertEqual(request.headers["X-StoreKit-Version"], "2")
        let receipt = RevenueCatReceipt(customer: "a", jws: "j", productID: "p", transactionID: "7", appTransaction: "app", restore: true, source: .restore)
        guard case .ok = await client.post(receipt) else { return XCTFail("post") }
        let body = try JSONValue.decode(try XCTUnwrap(http.requests("POST /v1/receipts").first?.body))
        XCTAssertEqual(body, .object([
            "payload_version": .number(1), "app_user_id": .string("a"), "fetch_token": .string("j"), "product_id": .string("p"),
            "transaction_id": .string("7"), "is_restore": .bool(true), "observer_mode": .bool(false), "initiation_source": .string("restore"),
            "sdk_originated": .bool(false), "app_transaction": .string("app"),
        ]))
        assertEqual(await client.subscriber(customer: "x"), .refused(status: 401, message: "Invalid API key"))
    }
}

// MARK: Fakes

/// The App Store: what it sells, what each sheet comes to, and what it holds.
final class FakeStore: SubscriptionStore, @unchecked Sendable {
    enum Next { case bought, pending, cancel, held }

    private let lock = NSLock()
    private var state = State()
    private struct State {
        var next: Next = .bought
        var products = ["happy_monthly": StoreProduct(id: "happy_monthly", displayPrice: "$19.99")]
        var purchases: [StoreTransaction] = []
        var unfinished: [StoreTransaction] = []
        var entitlements: [StoreTransaction] = []
        var finished: [String] = []
        var synced = false
        var open = false
        var held: CheckedContinuation<StorePurchase, Never>?
        var continuation: AsyncStream<StoreTransaction>.Continuation?
    }

    private func with<T>(_ body: (inout State) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&state)
    }

    var next: Next { get { with { $0.next } } set { with { $0.next = newValue } } }
    var purchases: [StoreTransaction] { with { $0.purchases } }
    var finished: [String] { with { $0.finished } }
    var synced: Bool { with { $0.synced } }
    var open: Bool { with { $0.open } }
    var unfinishedList: [StoreTransaction] { get { with { $0.unfinished } } set { with { $0.unfinished = newValue } } }
    var entitlementList: [StoreTransaction] { get { with { $0.entitlements } } set { with { $0.entitlements = newValue } } }
    var productList: [String: StoreProduct] { get { with { $0.products } } set { with { $0.products = newValue } } }

    func product(_ id: String) async -> StoreLookup {
        with { $0.products[id] }.map(StoreLookup.found) ?? .missing
    }

    func purchase(_ id: String, token: UUID) async -> StorePurchase {
        let (next, count) = with { state -> (Next, Int) in
            state.open = true
            return (state.next, state.purchases.count)
        }
        let transaction = StoreTransaction(id: "t\(count + 1)", originalID: "t\(count + 1)", productID: id, jws: "jws.t\(count + 1)", token: token)
        with { $0.purchases.append(transaction) }
        defer { with { $0.open = false } }
        switch next {
        case .bought:
            with { $0.unfinished.append(transaction) }
            return .purchased(transaction)
        case .pending: return .pending
        case .cancel: return .cancelled
        case .held: return await withCheckedContinuation { continuation in with { $0.held = continuation } }
        }
    }

    func release(_ result: StorePurchase) {
        with { state in
            state.held?.resume(returning: result)
            state.held = nil
        }
    }

    func unfinished() async -> [StoreTransaction] { with { $0.unfinished } }
    func entitlements() async -> [StoreTransaction] { with { $0.entitlements } }
    func sync() async -> Bool { with { $0.synced = true }; return true }
    func appTransaction() async -> String? { "app.jws" }

    func finish(_ transaction: StoreTransaction) async {
        with { state in
            state.finished.append(transaction.id)
            state.unfinished.removeAll { $0.id == transaction.id }
        }
    }

    func updates() -> AsyncStream<StoreTransaction> {
        AsyncStream { continuation in with { $0.continuation = continuation } }
    }

    /// The store tells the app of `transaction`, as `Transaction.updates` does.
    func deliver(_ transaction: StoreTransaction) {
        let continuation = with { state -> AsyncStream<StoreTransaction>.Continuation? in
            state.unfinished.append(transaction)
            return state.continuation
        }
        continuation?.yield(transaction)
    }
}

/// RevenueCat: who has `pro`, and every call it was asked.
final class FakeRevenueCat: RevenueCatAPI, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _posted: [RevenueCatReceipt] = []
    private var _grants: [String: String] = [:]
    var offerings: JSONValue = FakeRevenueCat.offerings(product: "happy_monthly")
    var refuse: Int?
    var failPosts: Int?
    var unreachable = false
    /// A receipt taken grants `pro` to the customer it was posted for.
    var grantOnPost = true
    var onPost: (() -> Void)?
    var onSubscriber: ((String) -> Void)?
    var now: Double = 1_793_000_000

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    var calls: [String] { locked { _calls } }
    var posted: [RevenueCatReceipt] { locked { _posted } }

    static func offerings(product: String?) -> JSONValue {
        let packages: JSONValue = product.map { .array([.object(["identifier": .string("$rc_monthly"), "platform_product_identifier": .string($0)])]) } ?? .array([])
        return .object(["current_offering_id": .string("default"), "offerings": .array([.object(["identifier": .string("default"), "packages": packages])])])
    }

    /// `customer` has `pro` no more.
    func revoke(_ customer: String) {
        locked { _grants[customer] = nil }
    }

    /// `customer` has `pro` from `product` until `expires`, as of `at`.
    func grant(_ customer: String, product: String = "happy_monthly", expires: Double?, at: Double) {
        now = at
        let expiry = expires.map { Date(timeIntervalSince1970: $0).formatted(.iso8601) }.map { "\"\($0)\"" } ?? "null"
        let purchased = Date(timeIntervalSince1970: at - 86_400).formatted(.iso8601)
        locked { _grants[customer] = #""pro":{"expires_date":\#(expiry),"product_identifier":"\#(product)","purchase_date":"\#(purchased)"}"# }
    }

    private func answer(_ customer: String) -> RevenueCatAnswer {
        let entitlement = locked { _grants[customer] } ?? ""
        let at = Date(timeIntervalSince1970: now).formatted(.iso8601)
        return .ok(try! JSONValue.decode(Data(#"{"request_date":"\#(at)","subscriber":{"entitlements":{\#(entitlement)},"subscriptions":{}}}"#.utf8)))
    }

    func offerings(customer: String) async -> RevenueCatAnswer {
        locked { _calls.append("offerings \(customer)") }
        if unreachable { return .unreached }
        if let refuse { return .refused(status: refuse, message: nil) }
        return .ok(offerings)
    }

    func subscriber(customer: String) async -> RevenueCatAnswer {
        locked { _calls.append("subscriber \(customer)") }
        onSubscriber?(customer)
        if unreachable { return .unreached }
        if let refuse { return .refused(status: refuse, message: nil) }
        await Task.yield()
        return answer(customer)
    }

    func post(_ receipt: RevenueCatReceipt) async -> RevenueCatAnswer {
        locked { _calls.append("post \(receipt.customer)") }
        onPost?()
        await Task.yield()
        if unreachable { return .unreached }
        if let status = failPosts ?? refuse { return .refused(status: status, message: nil) }
        locked { _posted.append(receipt) }
        if grantOnPost { grant(receipt.customer, expires: now + 30 * 86_400, at: now) }
        return answer(receipt.customer)
    }
}

/// A call usage store kept in memory.
private final class MemoryCallUsage: CallUsageStore, @unchecked Sendable {
    var usage = CallUsage()
    func load() -> CallUsage { usage }
    func save(_ usage: CallUsage) { self.usage = usage }
}
