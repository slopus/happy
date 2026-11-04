#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Which offer sheet is up and what it is for. One subscription, one way
/// to buy it; what the sheet says depends on where it was opened.
enum OfferSheet: Equatable {
    /// Voice's welcome, before a first call: its "Start Voice Session" goes on to the call, for free.
    case welcome
    /// Voice's time is used; when some is back, if that is known. Its start is greyed out.
    case used(freeAgain: Date?)
    /// The relay's voice refused without the subscription: voice's sheet with no free way on.
    case required
}

/// How an offer sheet was closed.
enum OfferResult: Equatable {
    /// The welcome's "Start Voice Session": go on, for free.
    case start
    /// `pro` came while it was up and wasn't there when it opened: bought or restored.
    case pro
    /// Closed by its ✕ or a swipe, an account change, or another sheet was already up: nothing more.
    case dismissed
}

/// The app's one subscription (`Subscription`) and its offer sheets, one
/// at a time, for everything that sells it: the agent call's welcome and
/// used-up sheet, the relay's voice; Support Happy's page and Settings buy
/// and restore through it too. Built once,
/// with the build's RevenueCat key; without one it sells nothing.
@MainActor
public final class Offers {
    /// The app's; tests put their own in its place.
    public internal(set) static var shared = Offers(subscription: Offers.build())

    let subscription: Subscription
    let intro: CallIntro
    /// Debug builds' test screens only: the subscription drawn as on sale at this price.
    let preview: String?
    private weak var shown: OfferSheetViewController?
    private var observation: SubscriptionObservation?
    private var accountsObservation: AccountsObservation?

    init(subscription: Subscription, intro: CallIntro = CallIntro(), preview: String? = Offers.previewPrice) {
        self.subscription = subscription
        self.intro = intro
        self.preview = preview
    }

    /// The build's: StoreKit and RevenueCat with its key, nothing without
    /// one. Debug runs can ask for a fixture (`HAPPY_SUBSCRIPTION_FIXTURE`).
    private static func build() -> Subscription {
        #if DEBUG
        if let fixture = SubscriptionFixture(ProcessInfo.processInfo.environment["HAPPY_SUBSCRIPTION_FIXTURE"]) { return fixture.subscription }
        #endif
        let key = RevenueCatClient.key(Bundle.main.object(forInfoDictionaryKey: "HappyRevenueCatAppleKey"))
        return Subscription(
            store: key.map { _ in StoreKitSubscriptionStore() },
            revenueCat: key.map { RevenueCatClient(transport: URLSessionTransport(), key: $0) },
            defaults: UserDefaultsStore(suiteName: "happy.subscription")
        )
    }

    /// `HAPPY_CALL_OFFER=preview`, at the approved price or the run's
    /// (`HAPPY_CALL_OFFER_PRICE`); never in a release build.
    static var previewPrice: String? {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if environment["HAPPY_CALL_OFFER"] == "preview" { return environment["HAPPY_CALL_OFFER_PRICE"] ?? CallOffer.price }
        #endif
        return nil
    }

    /// At launch: the store's purchases are listened for from the first moment.
    public static func launch() {
        shared.subscription.launch()
    }

    /// The foreground: what's on sale, what the store left unfinished, what RevenueCat says.
    func foreground() {
        subscription.refresh()
    }

    /// The accounts, once they are known: whose subscription it is follows
    /// the Happy account in front, or the one before an agent connection.
    func follow(_ account: AccountController) {
        tell(account)
        accountsObservation = account.observeAccounts { [weak self, weak account] _ in
            guard let self, let account else { return }
            self.tell(account)
        }
    }

    func tell(_ account: AccountController) {
        // The relay token's `sub` (AccountSession.serverID), happy-app's RevenueCat appUserID.
        let active = account.session.flatMap { session in session.serverID.map { Subscription.Account(id: session.keys.anonID, subject: $0) } }
        let signedIn = Set(account.accounts.filter { !$0.isAgentConnection }.map(\.id))
        subscription.accounts(active: active, signedIn: signedIn)
    }

    /// What the sheets offer. A debug preview charges and grants nothing.
    var offer: CallOffer {
        #if DEBUG
        if let preview { return .preview(price: preview) }
        #endif
        return subscription.offer
    }

    /// The paid month the allowance counts in, if the customer has one.
    func month() -> ProMonth? { subscription.month() }

    /// Whether a voice button's tap now shows voice's welcome first, counted as seen.
    func welcomes() -> Bool { intro.welcomes(offer) }

    var isShowing: Bool { shown != nil }

    /// Shows `sheet` over `top`, unless one is up already, and answers how it was closed.
    func ask(_ sheet: OfferSheet, over top: UIViewController) async -> OfferResult {
        guard shown == nil, top.presentedViewController == nil || !(top.presentedViewController is OfferSheetViewController) else { return .dismissed }
        let proBefore = subscription.hasPro
        let generation = subscription.generation
        return await withCheckedContinuation { continuation in
            let controller: OfferSheetViewController = CallSheetViewController(sheet, offers: self)
            controller.onResult = { [weak self] result in
                self?.shown = nil
                self?.observation = nil
                continuation.resume(returning: result)
            }
            shown = controller
            // pro came, or another customer: the sheet has done its work, or isn't theirs.
            observation = subscription.observe { [weak self, weak controller] in
                guard let self, let controller else { return }
                if self.subscription.generation != generation { return controller.finish(.dismissed) }
                if !proBefore, self.subscription.hasPro { return controller.finish(.pro) }
                controller.offerChanged()
            }
            controller.modalPresentationStyle = .pageSheet
            controller.sheetPresentationController?.detents = [.large()]
            controller.sheetPresentationController?.preferredCornerRadius = 28
            top.present(controller, animated: true)
        }
    }

    /// `ask`, answered to no one: a sheet that only offers.
    func show(_ sheet: OfferSheet, over top: UIViewController) {
        Task { _ = await ask(sheet, over: top) }
    }

    /// The sheets' and Settings' Subscribe: the store's own sheet, which
    /// confirms; what it came to said where it needs saying.
    func subscribe(from controller: UIViewController) async {
        if case .preview = offer { return Alerts.show(Strings.Call.upgradePreviewTitle, Strings.Call.upgradePreviewMessage, on: controller) }
        let result = await subscription.buy()
        guard controller.viewIfLoaded?.window != nil else { return }
        switch result {
        case .pending: Alerts.show(Strings.Offer.pendingTitle, Strings.Offer.pendingMessage, on: controller)
        case .failed: Alerts.show(Strings.Offer.failedTitle, Strings.Offer.failedMessage, on: controller)
        case .unconfirmed: Alerts.show(Strings.Offer.unconfirmedTitle, Strings.Offer.unconfirmedMessage, on: controller)
        case .purchased, .cancelled, .unavailable: break
        }
    }

    /// The sheets' and Settings' Restore Purchases, on the person's tap
    /// only; nothing restores by itself.
    func restore(from controller: UIViewController) async {
        if case .preview = offer { return Alerts.show(Strings.Call.upgradePreviewTitle, Strings.Call.upgradePreviewMessage, on: controller) }
        let result = await subscription.restore()
        guard controller.viewIfLoaded?.window != nil else { return }
        switch result {
        case .restored: Alerts.show(Strings.Offer.restoredTitle, on: controller)
        case .nothingFound: Alerts.show(Strings.Offer.nothingTitle, Strings.Offer.nothingMessage, on: controller)
        case .failed: Alerts.show(Strings.Offer.restoreFailedTitle, Strings.Offer.restoreFailedMessage, on: controller)
        }
    }

    /// Whether Restore can be asked at all: a build with RevenueCat's key.
    var canRestore: Bool {
        if case .preview = offer { return true }
        return subscription.problem != .unconfigured
    }

    /// Whether the store holds a purchase RevenueCat hasn't confirmed yet.
    var unconfirmed: Bool { subscription.unconfirmed }

    /// Told when what the subscription says changes, until the token goes.
    func observe(_ handler: @escaping @MainActor () -> Void) -> SubscriptionObservation {
        subscription.observe(handler)
    }
}

/// What every offer sheet shares: one result, said once, whether it was
/// closed by a button, its ✕ or a swipe down.
@MainActor
class OfferSheetViewController: UIViewController, UIAdaptivePresentationControllerDelegate {
    let offers: Offers
    var onResult: ((OfferResult) -> Void)?
    private var result: OfferResult?

    init(offers: Offers) {
        self.offers = offers
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        presentationController?.delegate = self
    }

    /// What is on offer changed while it is up.
    func offerChanged() {}

    /// Goes, answering `result`; only the first answer counts.
    func finish(_ result: OfferResult) {
        guard self.result == nil else { return }
        self.result = result
        if presentingViewController != nil {
            dismiss(animated: true) { [weak self] in self?.answer() }
        } else {
            answer()
        }
    }

    private func answer() {
        guard let result else { return }
        onResult?(result)
        onResult = nil
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        if result == nil { result = .dismissed }
        answer()
    }

    /// Gone some other way (dismissed from outside, or with what presented it): a dismissal.
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isBeingDismissed || presentingViewController == nil else { return }
        if result == nil { result = .dismissed }
        answer()
    }
}
#endif

#if canImport(UIKit)
/// The sheets' quiet text action on the gradient, "Restore Purchases" or
/// "Manage Subscriptions": Restore restores on the tap, says what it
/// found, and can't be tapped again until it has. 44 points tall to touch.
@MainActor
final class OfferLink: UIControl {
    private let label = StyledLabel(style: CallSheetViewController.detailStyle, color: Palette.startTextSecondary, lines: 0, alignment: .center)

    static func restore(for sheet: OfferSheetViewController) -> OfferLink {
        restore(offers: sheet.offers, from: sheet)
    }

    /// Restore Purchases for `offers`, its answers said over `controller`.
    static func restore(offers: Offers, from controller: UIViewController) -> OfferLink {
        let link = OfferLink(title: Strings.Offer.restore)
        link.accessibilityIdentifier = "offer-restore"
        link.addAction(UIAction { [weak controller, weak link] _ in
            guard let controller, let link else { return }
            link.isEnabled = false
            Task {
                await offers.restore(from: controller)
                link.isEnabled = true
            }
        }, for: .touchUpInside)
        return link
    }

    init(title: String) {
        super.init(frame: .zero)
        label.string = title
        label.isUserInteractionEnabled = false
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor),
            label.topAnchor.constraint(greaterThanOrEqualTo: topAnchor, constant: 8),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
        isAccessibilityElement = true
        accessibilityLabel = title
        accessibilityTraits = .button
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var isHighlighted: Bool {
        didSet { label.alpha = isHighlighted ? 0.5 : 1 }
    }

    override var isEnabled: Bool {
        didSet {
            alpha = isEnabled ? 1 : 0.4
            accessibilityTraits = isEnabled ? .button : [.button, .notEnabled]
        }
    }
}
#endif
