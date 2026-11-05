#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The app's offers for the rest of `test`, over a fixture subscription
/// (`SubscriptionFixture`) that charges nothing and reaches nothing, its
/// welcome never seen. The app's own come back after.
@MainActor
func hostedOffers(_ fixture: String, preview: String? = nil, for test: XCTestCase) async throws -> Offers {
    let subscription = try XCTUnwrap(SubscriptionFixture(fixture)).subscription
    let suite = "hosted-offers-\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    let offers = Offers(subscription: subscription, intro: CallIntro(defaults: defaults), preview: preview)
    let app = Offers.shared
    Offers.shared = offers
    test.addTeardownBlock { @MainActor in
        Offers.shared = app
        UserDefaults.standard.removePersistentDomain(forName: suite)
    }
    subscription.relay(nil)
    await subscription.idle()
    return offers
}

/// The offer sheets, one subscription behind them all: which sheet says
/// what, how each closes, and what buying in one does. Pictures go to the
/// repository's `.context/evidence/offers`.
@MainActor
final class HostedOfferSheetsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/offers")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    private func capture(_ window: UIWindow, _ name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let file = "\(name)-\(window.traitCollection.userInterfaceStyle == .dark ? "dark" : "light")"
        let attachment = XCTAttachment(image: image)
        attachment.name = file
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = Self.evidence, let data = image.pngData() {
            try? data.write(to: folder.appendingPathComponent("\(file).png"))
        }
    }

    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<100 where !condition() { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertTrue(condition(), "never came")
    }

    private func host(_ root: UIViewController = UIViewController(), style: UIUserInterfaceStyle = .light) async throws -> (UIViewController, UIWindow) {
        let navigation = UINavigationController(rootViewController: root)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        window.overrideUserInterfaceStyle = style
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()
        return (root, window)
    }

    private func subview<T: UIView>(_ type: T.Type, in view: UIView, where match: (T) -> Bool = { _ in true }) -> T? {
        if let view = view as? T, match(view) { return view }
        for child in view.subviews { if let found = subview(type, in: child, where: match) { return found } }
        return nil
    }

    /// Asks for `sheet` over `top`, and hands back the sheet once it is up and the answer to come.
    private func open<Sheet: OfferSheetViewController>(_ sheet: OfferSheet, _ offers: Offers, over top: UIViewController, as type: Sheet.Type) async throws -> (Sheet, Task<OfferResult, Never>) {
        let answer = Task { await offers.ask(sheet, over: top) }
        try await until { top.presentedViewController is Sheet && top.transitionCoordinator == nil }
        return (try XCTUnwrap(top.presentedViewController as? Sheet), answer)
    }

    /// Pushes Support Happy's page over `top`, as Settings' boba row does, once it has landed.
    private func pushSupport(_ offers: Offers, over top: UIViewController) async throws -> SupportViewController {
        let page = SupportViewController(offers: offers)
        let navigation = try XCTUnwrap(top.navigationController)
        navigation.pushViewController(page, animated: false)
        try await until { navigation.topViewController === page && navigation.transitionCoordinator == nil }
        page.view.layoutIfNeeded()
        return page
    }

    private func closed(_ top: UIViewController) async throws {
        try await until { top.presentedViewController == nil && top.transitionCoordinator == nil }
    }

    /// On sale: the welcome, the used sheet, the relay's refusal and
    /// Support Happy's page, each with the store's price, Subscribe and
    /// Restore; the page has Manage Subscriptions too.
    /// Only the welcome's start starts; ✕ never does.
    func testEachSheetAndHowItCloses() async throws {
        let offers = try await hostedOffers("onsale", for: self)
        XCTAssertEqual(offers.offer, .onSale(price: "$19.99"))
        for style in [UIUserInterfaceStyle.light, .dark] {
            let (top, window) = try await host(style: style)

            var (sheet, answer) = try await open(.welcome, offers, over: top, as: CallSheetViewController.self)
            XCTAssertNotNil(sheet.subscribe)
            XCTAssertNotNil(sheet.restore)
            XCTAssertTrue(sheet.session.isEnabled)
            XCTAssertNotNil(sheet.session.superview)
            try await Task.sleep(for: .seconds(1))
            capture(window, "welcome")
            // Another while one is up: not shown, nothing more.
            let second = await offers.ask(.required, over: top)
            XCTAssertEqual(second, .dismissed)
            sheet.close.sendActions(for: .primaryActionTriggered)
            var result = await answer.value
            XCTAssertEqual(result, .dismissed, "✕ answered something")
            try await closed(top)

            (sheet, answer) = try await open(.welcome, offers, over: top, as: CallSheetViewController.self)
            sheet.session.sendActions(for: .touchUpInside)
            result = await answer.value
            XCTAssertEqual(result, .start)
            try await closed(top)

            (sheet, answer) = try await open(.used(freeAgain: Date().addingTimeInterval(3 * 86_400)), offers, over: top, as: CallSheetViewController.self)
            XCTAssertFalse(sheet.session.isEnabled, "used time starts a call")
            XCTAssertNotNil(sheet.session.superview)
            XCTAssertNotNil(sheet.subscribe)
            try await Task.sleep(for: .seconds(1))
            capture(window, "used")
            sheet.session.sendActions(for: .touchUpInside)
            sheet.close.sendActions(for: .primaryActionTriggered)
            result = await answer.value
            XCTAssertEqual(result, .dismissed)
            try await closed(top)

            (sheet, answer) = try await open(.required, offers, over: top, as: CallSheetViewController.self)
            XCTAssertNil(sheet.session.superview, "the relay's refusal offers a free way on")
            XCTAssertNotNil(sheet.subscribe)
            try await Task.sleep(for: .seconds(1))
            capture(window, "required")
            sheet.close.sendActions(for: .primaryActionTriggered)
            result = await answer.value
            XCTAssertEqual(result, .dismissed)
            try await closed(top)

            let support = try await pushSupport(offers, over: top)
            XCTAssertNil(subview(SessionButton.self, in: support.view), "Support Happy offers a voice session")
            XCTAssertEqual(support.subscribe?.isEnabled, true)
            XCTAssertEqual(support.restore?.isEnabled, true)
            XCTAssertEqual(support.manage?.isEnabled, true)
            try await Task.sleep(for: .seconds(1.2))
            capture(window, "support")
            top.navigationController?.popViewController(animated: false)
        }
    }

    /// A swipe down is a dismissal like ✕.
    func testSwipeDownDismisses() async throws {
        let offers = try await hostedOffers("onsale", for: self)
        let (top, _) = try await host()
        let (sheet, answer) = try await open(.welcome, offers, over: top, as: CallSheetViewController.self)
        let presentation = try XCTUnwrap(sheet.presentationController)
        await withCheckedContinuation { done in sheet.dismiss(animated: false) { done.resume() } }
        sheet.presentationControllerDidDismiss(presentation)
        let result = await answer.value
        XCTAssertEqual(result, .dismissed)
    }

    /// Subscribe in the welcome: the store's sheet, RevenueCat grants pro,
    /// and the sheet goes answering pro, not start. It is the subscription
    /// now everywhere, and the welcome isn't shown again.
    func testBuyingInTheWelcomeAnswersProAndNeverStarts() async throws {
        let offers = try await hostedOffers("onsale", for: self)
        XCTAssertTrue(offers.welcomes())
        XCTAssertFalse(offers.welcomes(), "the welcome came twice")
        let (top, window) = try await host()
        let (sheet, answer) = try await open(.welcome, offers, over: top, as: CallSheetViewController.self)
        let subscribe = try XCTUnwrap(sheet.subscribe)
        subscribe.sendActions(for: .touchUpInside)
        let result = await answer.value
        XCTAssertEqual(result, .pro)
        XCTAssertEqual(offers.offer, .subscribed)
        XCTAssertTrue(offers.subscription.hasPro)
        XCTAssertNotNil(offers.month())
        try await closed(top)

        // Support Happy still opens, says what they pay and thanks them;
        // they can manage it, with nothing to restore.
        let support = try await pushSupport(offers, over: top)
        XCTAssertNil(support.subscribe)
        XCTAssertNil(support.restore)
        XCTAssertEqual(support.heading?.string, "You’re subscribed at $19.99/month.")
        XCTAssertNotNil(subview(StyledLabel.self, in: support.view) { $0.string == "Thank you for your support!" })
        XCTAssertEqual(support.manage?.isEnabled, true)
        try await Task.sleep(for: .seconds(1.2))
        capture(window, "support-subscribed")
    }

    /// Pro from before (any product): no welcome, no Subscribe anywhere,
    /// Settings' Support still opens Support Happy, and the Voice page
    /// says Subscribed with this month's hours.
    func testExistingProSkipsTheWelcome() async throws {
        let offers = try await hostedOffers("subscribed", for: self)
        XCTAssertEqual(offers.offer, .subscribed)
        XCTAssertFalse(offers.welcomes())
        XCTAssertTrue(offers.intro.due, "the welcome was counted as seen without showing")

        let page = AgentVoiceViewController()
        let (_, window) = try await host(page)
        XCTAssertEqual(page.shownRow("voice-plan")?.value, Strings.Offer.subscribed)
        XCTAssertEqual(page.shownRow("voice-free")?.value, Strings.Offer.includedValue)
        XCTAssertNil(page.shownRow("voice-subscribe"))
        XCTAssertNotNil(page.shownRow("voice-thanks"))
        try await Task.sleep(for: .milliseconds(300))
        capture(window, "voice-page-subscribed")

        let (sheet, answer) = try await open(.welcome, offers, over: page, as: CallSheetViewController.self)
        XCTAssertNil(sheet.subscribe)
        XCTAssertNil(sheet.restore)
        sheet.close.sendActions(for: .primaryActionTriggered)
        _ = await answer.value
    }

    /// The Voice page buys with the store's own sheet, nothing of ours in
    /// between, and says Subscribed when it comes.
    func testVoicePageBuysDirectly() async throws {
        let offers = try await hostedOffers("onsale", for: self)
        let page = AgentVoiceViewController()
        let (_, window) = try await host(page)
        XCTAssertEqual(page.shownRow("voice-subscribe")?.value, "$19.99/month")
        XCTAssertNotNil(page.shownRow("voice-restore")?.action)
        XCTAssertNotEqual(page.shownRow("voice-restore")?.dimmed, true)
        try await Task.sleep(for: .milliseconds(300))
        capture(window, "voice-page-onsale")
        page.tapRow("voice-subscribe")
        XCTAssertFalse(page.presentedViewController is OfferSheetViewController)
        try await until { offers.offer == .subscribed }
        try await until { page.shownRow("voice-plan")?.value == Strings.Offer.subscribed }
        XCTAssertNil(page.presentedViewController, "buying said something")
    }

    /// Ask to Buy: Subscribe says it waits for approval, and nothing is granted.
    func testPendingPurchaseSaysSo() async throws {
        let offers = try await hostedOffers("pending", for: self)
        let (top, window) = try await host()
        let (sheet, answer) = try await open(.used(freeAgain: nil), offers, over: top, as: CallSheetViewController.self)
        try XCTUnwrap(sheet.subscribe).sendActions(for: .touchUpInside)
        try await until { (sheet.presentedViewController as? UIAlertController)?.title == Strings.Offer.pendingTitle }
        XCTAssertFalse(offers.subscription.hasPro)
        try await Task.sleep(for: .milliseconds(400))
        capture(window, "pending")
        await withCheckedContinuation { done in sheet.presentedViewController?.dismiss(animated: false) { done.resume() } }
        sheet.close.sendActions(for: .primaryActionTriggered)
        let result = await answer.value
        XCTAssertEqual(result, .dismissed)
    }

    /// Bought, but RevenueCat can't be reached: it says it was received,
    /// grants nothing yet, and the sheet notes it is being confirmed.
    func testUnconfirmedPurchase() async throws {
        let offers = try await hostedOffers("unconfirmed", for: self)
        let (top, window) = try await host()
        let (sheet, answer) = try await open(.welcome, offers, over: top, as: CallSheetViewController.self)
        try XCTUnwrap(sheet.subscribe).sendActions(for: .touchUpInside)
        try await until { (sheet.presentedViewController as? UIAlertController)?.title == Strings.Offer.unconfirmedTitle }
        XCTAssertTrue(offers.unconfirmed)
        XCTAssertFalse(offers.subscription.hasPro)
        await withCheckedContinuation { done in sheet.presentedViewController?.dismiss(animated: false) { done.resume() } }
        try await Task.sleep(for: .milliseconds(600))
        capture(window, "unconfirmed")
        sheet.close.sendActions(for: .primaryActionTriggered)
        let result = await answer.value
        XCTAssertEqual(result, .dismissed)
    }

    /// Nothing on sale (no monthly package), but a yearly subscription
    /// owned: Support Happy, voice's used sheet, Support us and the Voice
    /// page still restore it, and none of them offers Subscribe.
    func testRestoreWithNothingOnSale() async throws {
        let offers = try await hostedOffers("owned", for: self)
        XCTAssertEqual(offers.offer, .unavailable)
        XCTAssertTrue(offers.canRestore)
        XCTAssertFalse(offers.welcomes())

        let page = AgentVoiceViewController()
        let (_, window) = try await host(page)
        XCTAssertNil(page.shownRow("voice-subscribe")?.action)
        XCTAssertNotNil(page.shownRow("voice-restore")?.action)
        let support = SupportUsViewController(openURL: { _ in false })
        support.loadViewIfNeeded()
        XCTAssertEqual(support.shownRow("subscribe")?.dimmed, true)
        XCTAssertNotNil(support.shownRow("restore-purchases")?.action)

        let (used, usedAnswer) = try await open(.used(freeAgain: nil), offers, over: page, as: CallSheetViewController.self)
        XCTAssertNil(used.subscribe)
        XCTAssertNotNil(used.restore)
        used.close.sendActions(for: .primaryActionTriggered)
        _ = await usedAnswer.value
        try await closed(page)

        let sheet = try await pushSupport(offers, over: page)
        XCTAssertEqual(sheet.subscribe?.isEnabled, false, "Subscribe is gone, or offered with nothing on sale")
        let restore = try XCTUnwrap(sheet.restore)
        XCTAssertTrue(restore.isEnabled)
        try await Task.sleep(for: .seconds(1.2))
        capture(window, "support-owned")
        restore.sendActions(for: .touchUpInside)
        try await until { offers.offer == .subscribed }
        try await until { sheet.subscribe == nil }
        // A yearly subscription: no monthly price to say.
        XCTAssertEqual(sheet.heading?.string, "You’re subscribed.")
        XCTAssertNil(sheet.restore)
        try await until { page.shownRow("voice-plan")?.value == Strings.Offer.subscribed }
    }

    /// No RevenueCat key: nothing on sale, Restore greyed out, Support
    /// Happy still opens with Subscribe there and greyed out.
    func testUnconfiguredSellsNothing() async throws {
        let offers = try await hostedOffers("unconfigured", for: self)
        XCTAssertEqual(offers.offer, .unavailable)
        XCTAssertFalse(offers.canRestore)
        XCTAssertFalse(offers.welcomes())
        let (top, window) = try await host()
        let support = try await pushSupport(offers, over: top)
        XCTAssertEqual(support.subscribe?.isEnabled, false)
        XCTAssertEqual(support.restore?.isEnabled, false)
        XCTAssertEqual(support.manage?.isEnabled, true)
        try await Task.sleep(for: .seconds(1.2))
        capture(window, "support-unconfigured")
    }
}
#endif
