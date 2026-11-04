#if canImport(UIKit)
import HappyCore
import HappyLayout
import Lottie
import UIKit

/// Support Happy, from Settings' boba row: one full-height sheet in voice's
/// sheet style (`CallSheetViewController`), the boba playing where its mic
/// is, a headline and what sending boba is for, then the monthly pledge at
/// the store's price, Subscribe and Restore Purchases (`Offers`). Only
/// about supporting Happy: it has no voice session. Where nothing is on
/// sale it says so and offers no button; a subscriber is thanked. Debug
/// test runs can draw it as a no-charge preview. Closed by its ✕ or a
/// swipe down.
@MainActor
final class SupportSheetViewController: OfferSheetViewController {
    typealias Metrics = CallSheetViewController.Metrics

    private let gradient = GrainGradientView(palette: StartViewController.Colors.grain)
    private let boba = LottieAnimationView(configuration: LottieConfiguration(renderingEngine: .coreAnimation))
    private let scroll = UIScrollView()
    let close = UIButton(type: .system)
    /// On offer only: the subscription.
    private(set) var subscribe: RoundButton?
    private(set) var restore: OfferLink?
    private let footer = UIStackView()
    private var subscribeHeight: NSLayoutConstraint?
    private var footerBottom: NSLayoutConstraint?
    private var drawn: (CallOffer, Bool)?

    override init(offers: Offers = .shared) {
        super.init(offers: offers)
        followsTextSize()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        typealias Text = Strings.AgentVoice
        view.backgroundColor = StartViewController.Colors.grain.back
        view.accessibilityIdentifier = "support-sheet"
        gradient.frame = view.bounds
        gradient.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(gradient)

        boba.animation = StateSceneView.read(.boba)
        boba.contentMode = .scaleAspectFit
        boba.loopMode = .loop
        boba.backgroundBehavior = .pauseAndRestore
        boba.isAccessibilityElement = false

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

        var cross = UIButton.Configuration.filled()
        cross.image = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .bold))
        cross.baseBackgroundColor = UIColor(Palette.startText).withAlphaComponent(0.1)
        cross.baseForegroundColor = UIColor(Palette.startText)
        cross.cornerStyle = .capsule
        cross.background.backgroundInsets = NSDirectionalEdgeInsets(top: 6, leading: 6, bottom: 6, trailing: 6)
        close.configuration = cross
        close.accessibilityLabel = Strings.Call.close
        close.accessibilityIdentifier = "support-sheet-close"
        close.addAction(UIAction { [weak self] _ in self?.finish(.dismissed) }, for: .primaryActionTriggered)

        scroll.alwaysBounceVertical = true
        scroll.showsVerticalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        for view in [scroll, close] {
            view.translatesAutoresizingMaskIntoConstraints = false
            self.view.addSubview(view)
        }
        for view in [column, footer] {
            view.translatesAutoresizingMaskIntoConstraints = false
            scroll.addSubview(view)
        }
        // As voice's sheet places them: the actions at the foot, the column
        // in the middle of the space above, the whole taller once the words are.
        let content = scroll.contentLayoutGuide
        let frame = scroll.frameLayoutGuide
        let fit = content.heightAnchor.constraint(equalTo: frame.heightAnchor)
        fit.priority = .defaultLow
        let upper = UILayoutGuide()
        scroll.addLayoutGuide(upper)
        let tight = footer.heightAnchor.constraint(equalToConstant: 0)
        tight.priority = UILayoutPriority(600)
        let centre = column.centerYAnchor.constraint(equalTo: upper.centerYAnchor)
        centre.priority = UILayoutPriority(500)
        let footerBottom = footer.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16)
        self.footerBottom = footerBottom
        var constraints = [
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            content.widthAnchor.constraint(equalTo: frame.widthAnchor),
            content.heightAnchor.constraint(greaterThanOrEqualTo: frame.heightAnchor),
            fit,
            upper.topAnchor.constraint(equalTo: content.topAnchor),
            upper.bottomAnchor.constraint(equalTo: footer.topAnchor),
            column.topAnchor.constraint(greaterThanOrEqualTo: upper.topAnchor, constant: 48),
            column.bottomAnchor.constraint(lessThanOrEqualTo: upper.bottomAnchor, constant: -32),
            centre,
            tight,
            footerBottom,
            close.topAnchor.constraint(equalTo: view.topAnchor, constant: 10),
            close.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -10),
            close.widthAnchor.constraint(equalToConstant: 44),
            close.heightAnchor.constraint(equalToConstant: 44),
        ]
        for stack in [column, footer] {
            let fill = stack.widthAnchor.constraint(equalTo: frame.widthAnchor, constant: -2 * Metrics.side)
            fill.priority = .defaultHigh
            constraints += [
                stack.centerXAnchor.constraint(equalTo: frame.centerXAnchor),
                stack.widthAnchor.constraint(lessThanOrEqualToConstant: Metrics.column),
                stack.leadingAnchor.constraint(greaterThanOrEqualTo: frame.leadingAnchor, constant: Metrics.side),
                fill,
            ]
        }
        NSLayoutConstraint.activate(constraints)
    }

    override func offerChanged() {
        if isViewLoaded { drawFooter() }
    }

    /// The pledge at the store's price, Subscribe and Restore Purchases; a
    /// thank-you once subscribed; that pledges aren't open where nothing is
    /// on sale. Drawn again whenever what is on offer changes.
    private func drawFooter() {
        typealias Text = Strings.AgentVoice
        let offer = offers.offer
        let unconfirmed = offers.unconfirmed
        if let drawn, drawn == (offer, unconfirmed) { return }
        drawn = (offer, unconfirmed)
        for view in footer.arrangedSubviews { view.removeFromSuperview() }
        subscribe = nil
        subscribeHeight = nil
        var notes: [String] = []
        if let price = offer.price {
            let heading = StyledLabel(style: CallSheetViewController.offerStyle, color: Palette.startText, alignment: .center)
            heading.string = Text.sheetPrice(price)
            footer.addArrangedSubview(heading)
            footer.setCustomSpacing(20, after: heading)
            let subscribe = RoundButton(title: Strings.Call.subscribe)
            subscribe.action = { [weak self] in
                guard let self else { return }
                await self.offers.subscribe(from: self)
            }
            subscribe.accessibilityIdentifier = "support-sheet-subscribe"
            footer.addArrangedSubview(centred(subscribe, width: Metrics.button))
            self.subscribe = subscribe
            subscribeHeight = subscribe.heightAnchor.constraint(equalToConstant: 50)
            subscribeHeight?.isActive = true
            if case .preview = offer { notes.append(Strings.Call.upgradePreviewNote) }
        } else if offer == .subscribed {
            let thanks = StyledLabel(style: CallSheetViewController.offerStyle, color: Palette.startText, alignment: .center)
            thanks.string = Strings.SupportUs.thankYou
            footer.addArrangedSubview(thanks)
        } else if !unconfirmed {
            notes.append(Text.sheetNotYet)
        }
        restore = offers.canRestore && offer != .subscribed ? OfferLink.restore(for: self) : nil
        if let restore { footer.addArrangedSubview(restore) }
        if unconfirmed { notes.append(Strings.Offer.unconfirmedNote) }
        if !notes.isEmpty {
            let note = StyledLabel(style: CallSheetViewController.noteStyle, color: Palette.startTextSecondary, alignment: .center)
            note.string = notes.joined(separator: "\n")
            footer.addArrangedSubview(note)
        }
        view.setNeedsLayout()
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        footerBottom?.constant = -16 - view.safeAreaInsets.bottom
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard let subscribe else { return }
        let height = subscribe.layout(width: Metrics.button).size.height
        if subscribeHeight?.constant != height { subscribeHeight?.constant = height }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Still with Reduce Motion: the boba as it was drawn to rest.
        if UIAccessibility.isReduceMotionEnabled { boba.currentProgress = 1 } else { boba.play() }
    }

    /// Whether the boba is moving: for the tests.
    var isAnimating: Bool { boba.isAnimationPlaying }

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
