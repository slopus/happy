#if canImport(UIKit)
import HappyCore
import HappyLayout
import Lottie
import UIKit

/// Support Happy, from Settings' boba row: one full-height sheet in voice's
/// sheet style (`CallSheetViewController`), the boba playing where its mic
/// is, a headline and what sending boba is for, then the monthly
/// subscription. Only about supporting Happy: it has no voice session and
/// says nothing about voice. Nothing is on sale yet: release builds say so
/// and offer no button; debug test runs draw it as a no-charge preview
/// (`CallController.offer`). Closed by its ✕ or a swipe down.
@MainActor
final class SupportSheetViewController: UIViewController {
    typealias Metrics = CallSheetViewController.Metrics

    let offer: CallOffer
    private let gradient = GrainGradientView(palette: StartViewController.Colors.grain)
    private let boba = LottieAnimationView(configuration: LottieConfiguration(renderingEngine: .coreAnimation))
    private let scroll = UIScrollView()
    let close = UIButton(type: .system)
    /// On offer only: the subscription.
    let subscribe: RoundButton?
    private var subscribeHeight: NSLayoutConstraint?
    private var footerBottom: NSLayoutConstraint?

    init(offer: CallOffer) {
        self.offer = offer
        subscribe = offer.onSale ? RoundButton(title: Strings.Call.subscribe) : nil
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

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

        let footer = UIStackView()
        footer.axis = .vertical
        footer.spacing = 12
        let note = StyledLabel(style: CallSheetViewController.noteStyle, color: Palette.startTextSecondary, alignment: .center)
        if case .preview(let price) = offer, let subscribe {
            let heading = StyledLabel(style: CallSheetViewController.offerStyle, color: Palette.startText, alignment: .center)
            heading.string = Text.sheetPrice(price)
            footer.addArrangedSubview(heading)
            footer.setCustomSpacing(20, after: heading)
            subscribe.onTap = { [weak self] in self?.preview() }
            subscribe.accessibilityIdentifier = "support-sheet-subscribe"
            footer.addArrangedSubview(centred(subscribe, width: Metrics.button))
            note.string = Strings.Call.upgradePreviewNote
        } else {
            note.string = Text.sheetNotYet
        }
        footer.addArrangedSubview(note)

        var cross = UIButton.Configuration.filled()
        cross.image = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .bold))
        cross.baseBackgroundColor = UIColor(Palette.startText).withAlphaComponent(0.1)
        cross.baseForegroundColor = UIColor(Palette.startText)
        cross.cornerStyle = .capsule
        cross.background.backgroundInsets = NSDirectionalEdgeInsets(top: 6, leading: 6, bottom: 6, trailing: 6)
        close.configuration = cross
        close.accessibilityLabel = Strings.Call.close
        close.accessibilityIdentifier = "support-sheet-close"
        close.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .primaryActionTriggered)

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
        if let subscribe {
            subscribeHeight = subscribe.heightAnchor.constraint(equalToConstant: 50)
            subscribeHeight?.isActive = true
        }
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

    /// Debug test runs only: subscribing said plainly as nothing.
    private func preview() {
        let alert = UIAlertController(title: Strings.Call.upgradePreviewTitle, message: Strings.AgentVoice.sheetPreviewMessage, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Call.ok, style: .default))
        present(alert, animated: true)
    }

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

    /// In a full-height sheet of its own over `top`.
    @discardableResult
    static func present(offer: CallOffer, over top: UIViewController) -> SupportSheetViewController {
        let sheet = SupportSheetViewController(offer: offer)
        sheet.modalPresentationStyle = .pageSheet
        sheet.sheetPresentationController?.detents = [.large()]
        sheet.sheetPresentationController?.preferredCornerRadius = 28
        top.present(sheet, animated: true)
        return sheet
    }
}
#endif
