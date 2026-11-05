#if canImport(UIKit)
import HappyAnalytics
import HappyCore
import HappyLayout
import StoreKit
import UIKit

/// Support Happy, pushed from Settings' boba row (and Support us'
/// Subscribe): one page in voice's sheet style (`CallSheetViewController`)
/// under the standard bar, clear over the gradient. The boba where voice's
/// mic is, played once as the page appears and again on a tap
/// (`StateSceneView`), a headline and what sending boba is for, then the
/// monthly pledge at the store's price and Subscribe, always there and
/// greyed out while nothing is on sale, and under it Restore Purchases and
/// Manage Subscriptions as quiet links (`Offers`). It fits the screen and
/// never scrolls. Only about supporting Happy: it has no voice session. A
/// subscriber is told what they pay and thanked, with only Manage
/// Subscriptions under it. Debug test runs can draw it as a no-charge preview.
@MainActor
final class SupportViewController: UIViewController {
    typealias Metrics = CallSheetViewController.Metrics

    let offers: Offers
    private let gradient = GrainGradientView(palette: StartViewController.Colors.grain)
    private let boba = StateSceneView(scene: .boba, size: Metrics.mic, replayLabel: Strings.AgentVoice.sheetReplay)
    /// Not while subscribed: the subscription, greyed out while nothing is on sale.
    private(set) var subscribe: RoundButton?
    /// The pledge, or what a subscriber pays.
    private(set) var heading: StyledLabel?
    private(set) var restore: OfferLink?
    private(set) var manage: OfferLink?
    private let footer = UIStackView()
    private var subscribeHeight: NSLayoutConstraint?
    private var drawn: (CallOffer, Bool, String?)?
    private var observation: SubscriptionObservation?

    init(offers: Offers = .shared) {
        self.offers = offers
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
        // Bought, restored, or another customer: the page says so at once.
        observation = offers.observe { [weak self] in
            guard let self, self.isViewLoaded else { return }
            self.drawFooter()
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        typealias Text = Strings.AgentVoice
        view.backgroundColor = StartViewController.Colors.grain.back
        view.accessibilityIdentifier = "support-page"
        gradient.frame = view.bounds
        gradient.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(gradient)
        // The gradient shows through the bar.
        let bar = UINavigationBarAppearance()
        bar.configureWithTransparentBackground()
        navigationItem.standardAppearance = bar
        navigationItem.scrollEdgeAppearance = bar
        navigationItem.compactAppearance = bar
        minimalBackButton()

        let title = StyledLabel(style: CallSheetViewController.titleStyle, color: Palette.startText, alignment: .center)
        title.accessibilityTraits = .header
        title.decoration = StartGalleryView.noOrphan
        title.string = Text.sheetTitle
        let body = StyledLabel(style: CallSheetViewController.rowStyle, color: Palette.startTextSecondary, alignment: .center)
        body.decoration = StartGalleryView.noOrphan
        body.string = Text.sheetBody
        let column = UIStackView(arrangedSubviews: [centred(boba, height: Metrics.mic), title, body])
        column.axis = .vertical
        column.spacing = 12

        footer.axis = .vertical
        footer.spacing = 12
        drawFooter()

        for view in [column, footer] {
            view.translatesAutoresizingMaskIntoConstraints = false
            self.view.addSubview(view)
        }
        // As voice's sheet places them: the actions at the foot, the column
        // in the middle of the space above. Words too tall for the screen
        // give way in the body first.
        body.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        let safe = view.safeAreaLayoutGuide
        let upper = UILayoutGuide()
        view.addLayoutGuide(upper)
        let centre = column.centerYAnchor.constraint(equalTo: upper.centerYAnchor)
        centre.priority = UILayoutPriority(500)
        var constraints = [
            // Under the bar, which the gradient runs behind.
            upper.topAnchor.constraint(equalTo: safe.topAnchor),
            upper.bottomAnchor.constraint(equalTo: footer.topAnchor),
            column.topAnchor.constraint(greaterThanOrEqualTo: upper.topAnchor, constant: 16),
            column.bottomAnchor.constraint(lessThanOrEqualTo: upper.bottomAnchor, constant: -32),
            centre,
            footer.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -16),
        ]
        for stack in [column, footer] {
            let fill = stack.widthAnchor.constraint(equalTo: view.widthAnchor, constant: -2 * Metrics.side)
            fill.priority = .defaultHigh
            constraints += [
                stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                stack.widthAnchor.constraint(lessThanOrEqualToConstant: Metrics.column),
                stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: Metrics.side),
                fill,
            ]
        }
        NSLayoutConstraint.activate(constraints)
    }

    /// The pledge at the store's price and Subscribe, greyed out with why
    /// while pledges aren't open, then Restore Purchases and Manage
    /// Subscriptions side by side; once subscribed, what they pay a month
    /// and a thank-you over Manage Subscriptions alone. Drawn again
    /// whenever what is on offer changes.
    private func drawFooter() {
        typealias Text = Strings.AgentVoice
        let offer = offers.offer
        let unconfirmed = offers.unconfirmed
        let paying = offers.subscribedPrice
        if let drawn, drawn == (offer, unconfirmed, paying) { return }
        drawn = (offer, unconfirmed, paying)
        for view in footer.arrangedSubviews { view.removeFromSuperview() }
        subscribe = nil
        subscribeHeight = nil
        var notes: [String] = []
        if offer == .subscribed {
            let heading = StyledLabel(style: CallSheetViewController.offerStyle, color: Palette.startText, alignment: .center)
            heading.string = paying.map(Text.sheetSubscribed) ?? Text.sheetSubscribedNoPrice
            heading.accessibilityIdentifier = "support-page-heading"
            footer.addArrangedSubview(heading)
            self.heading = heading
            footer.setCustomSpacing(4, after: heading)
            let thanks = StyledLabel(style: CallSheetViewController.offerStyle, color: Palette.startText, alignment: .center)
            thanks.string = Text.sheetThanks
            thanks.accessibilityIdentifier = "support-page-thanks"
            footer.addArrangedSubview(thanks)
        } else {
            let heading = StyledLabel(style: offer.price == nil ? CallSheetViewController.detailStyle : CallSheetViewController.offerStyle,
                                      color: offer.price == nil ? Palette.startTextSecondary : Palette.startText, alignment: .center)
            heading.string = offer.price.map(Text.sheetPrice) ?? Text.sheetNotYet
            heading.accessibilityIdentifier = "support-page-heading"
            // Said only while there is something to say: a purchase waiting on RevenueCat says that instead.
            heading.isHidden = offer.price == nil && unconfirmed
            footer.addArrangedSubview(heading)
            self.heading = heading
            footer.setCustomSpacing(offer.price == nil ? 12 : 20, after: heading)
            let subscribe = RoundButton(title: Strings.Call.subscribe)
            subscribe.action = { [weak self] in
                guard let self else { return }
                await self.offers.subscribe(from: self)
            }
            subscribe.isEnabled = offer.price != nil
            subscribe.accessibilityIdentifier = "support-page-subscribe"
            footer.addArrangedSubview(centred(subscribe, width: Metrics.button))
            self.subscribe = subscribe
            subscribeHeight = subscribe.heightAnchor.constraint(equalToConstant: 50)
            subscribeHeight?.isActive = true
            if case .preview = offer { notes.append(Strings.Call.upgradePreviewNote) }
        }
        if let last = footer.arrangedSubviews.last { footer.setCustomSpacing(4, after: last) }
        // Nothing to restore for a subscriber.
        let restore = offer == .subscribed ? nil : OfferLink.restore(offers: offers, from: self)
        restore?.isEnabled = offers.canRestore
        self.restore = restore
        let manage = OfferLink(title: Strings.Offer.manage)
        manage.accessibilityIdentifier = "offer-manage"
        manage.addAction(UIAction { [weak self] _ in self?.manageSubscriptions() }, for: .touchUpInside)
        self.manage = manage
        let links = UIStackView(arrangedSubviews: [restore, manage].compactMap { $0 })
        links.axis = .horizontal
        links.distribution = .fillEqually
        links.alignment = .center
        links.spacing = 8
        footer.addArrangedSubview(links)
        if unconfirmed { notes.append(Strings.Offer.unconfirmedNote) }
        if !notes.isEmpty {
            let note = StyledLabel(style: CallSheetViewController.noteStyle, color: Palette.startTextSecondary, alignment: .center)
            note.string = notes.joined(separator: "\n")
            footer.addArrangedSubview(note)
        }
        view.setNeedsLayout()
    }

    /// The App Store's own subscriptions sheet, or its page where that can't be shown.
    private func manageSubscriptions() {
        guard let scene = view.window?.windowScene else { return }
        Task {
            do {
                try await AppStore.showManageSubscriptions(in: scene)
            } catch {
                await UIApplication.shared.open(SupportUsViewController.manageSubscriptionsURL)
            }
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Once each time it is opened with Subscribe on it, not on coming
        // back to it from Manage Subscriptions or a sheet; a subscriber's
        // thank-you sells nothing.
        if isMovingToParent || isBeingPresented, offers.offer != .subscribed { Analytics.shared.paywallPresented() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard let subscribe else { return }
        let height = subscribe.layout(width: Metrics.button).size.height
        if subscribeHeight?.constant != height { subscribeHeight?.constant = height }
    }

    /// Whether the boba is moving: for the tests.
    var isAnimating: Bool { boba.isAnimating }
    /// Where its one play has got to, 0…1: for the tests.
    var bobaProgress: CGFloat { boba.progress }
    /// Plays the boba once more, as a tap does: for the tests.
    func replayBoba() { boba.replay() }

    /// `view` in the middle of the column, `width` or `height` fixed.
    private func centred(_ view: UIView, width: CGFloat? = nil, height: CGFloat? = nil) -> UIView {
        let holder = UIView()
        view.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(view)
        var constraints = [
            view.topAnchor.constraint(equalTo: holder.topAnchor),
            view.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            view.centerXAnchor.constraint(equalTo: holder.centerXAnchor),
            view.widthAnchor.constraint(lessThanOrEqualTo: holder.widthAnchor),
        ]
        if let width {
            let preferred = view.widthAnchor.constraint(equalToConstant: width)
            preferred.priority = .defaultHigh
            constraints.append(preferred)
        }
        if let height { constraints += [view.heightAnchor.constraint(equalToConstant: height), view.widthAnchor.constraint(equalToConstant: height)] }
        NSLayoutConstraint.activate(constraints)
        return holder
    }
}
#endif
