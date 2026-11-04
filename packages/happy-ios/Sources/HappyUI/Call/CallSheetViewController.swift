#if canImport(UIKit)
import HappyCore
import HappyLayout
import Lottie
import UIKit

/// Voice's two full-height sheets, in the first screen's style
/// (`StartViewController`): its Grain Gradient behind, its words and pill
/// on it, centred. The welcome a device sees before its first call, and
/// the same screen once its free time is used (`CallAllowance`), its start
/// greyed out. The podcast mic, a headline and what voice does; at the
/// bottom the subscription where one is on offer, then "Start Voice
/// Session". Closed by its ✕ or a swipe down, which starts nothing.
@MainActor
final class CallSheetViewController: UIViewController {
    enum Screen: Equatable {
        /// Before the first call.
        case welcome(offer: CallOffer)
        /// The free time is used; when some is back, if that is known.
        case used(freeAgain: Date?, offer: CallOffer)

        var offer: CallOffer {
            switch self {
            case .welcome(let offer), .used(_, let offer): offer
            }
        }
    }

    enum Metrics {
        static let mic: CGFloat = 120
        static let column: CGFloat = 440
        static let side: CGFloat = 28
        static let button: CGFloat = 300
    }

    static let titleStyle = TextStyles.startSlideTitle
    static let rowStyle = TextStyle(.semiBold, size: 17, lineHeight: 22, maxScale: 1.6)
    static let offerStyle = TextStyle(.semiBold, size: 20, lineHeight: 26, maxScale: 1.4)
    static let detailStyle = TextStyle(.regular, size: 15, lineHeight: 20, maxScale: 1.6)
    static let noteStyle = TextStyle(.regular, size: 13, lineHeight: 18, maxScale: 1.6)

    let screen: Screen
    /// "Start Voice Session" on the welcome: the free call, once the sheet has gone.
    var onStart: (() -> Void)?

    private let gradient = GrainGradientView(palette: StartViewController.Colors.grain)
    private let mic = LottieAnimationView(configuration: LottieConfiguration(renderingEngine: .coreAnimation))
    private let scroll = UIScrollView()
    let close = UIButton(type: .system)
    /// On offer only: the subscription, the main action.
    let subscribe: RoundButton?
    /// The free call; the main action when nothing is on offer, greyed out once the free time is used.
    let session: SessionButton
    private let note = StyledLabel(style: CallSheetViewController.noteStyle, color: Palette.startTextSecondary, alignment: .center)
    private var subscribeHeight: NSLayoutConstraint?
    private var footerBottom: NSLayoutConstraint?

    init(_ screen: Screen) {
        self.screen = screen
        let offered = screen.offer.onSale
        subscribe = offered ? RoundButton(title: Strings.Call.subscribe) : nil
        session = SessionButton(title: Strings.Call.startSession, prominent: !offered)
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = StartViewController.Colors.grain.back
        view.accessibilityIdentifier = { if case .welcome = screen { "call-welcome" } else { "call-paywall" } }()
        gradient.frame = view.bounds
        gradient.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(gradient)

        mic.animation = Self.micAnimation
        mic.contentMode = .scaleAspectFit
        mic.loopMode = .loop
        mic.backgroundBehavior = .pauseAndRestore
        mic.isAccessibilityElement = false

        // The mic, the headline and what voice does, in the middle of the space above the actions.
        let title = StyledLabel(style: Self.titleStyle, color: Palette.startText, alignment: .center)
        title.accessibilityTraits = .header
        title.decoration = StartGalleryView.noOrphan
        title.string = Strings.Call.welcomeTitle
        let offer = screen.offer
        // Once the free time is used, that under its line, in the app's warning colour.
        let used: String? = switch screen {
        case .welcome: nil
        case .used(let freeAgain, _): freeAgain.map { Strings.Call.usedNote(Self.when($0, now: Date())) } ?? Strings.Call.usedNoteLater
        }
        let benefits = UIStackView(arrangedSubviews: [
            Benefit(symbol: "text.bubble", title: Strings.Call.welcomeAsk),
            Benefit(symbol: "paperplane", title: Strings.Call.welcomeAct),
            Benefit(symbol: "gift", title: Strings.Call.welcomeFree, warning: used),
        ])
        benefits.axis = .vertical
        benefits.alignment = .leading
        benefits.spacing = 16
        let column = UIStackView(arrangedSubviews: [centred(mic, height: Metrics.mic), title, centred(benefits)])
        column.axis = .vertical
        column.spacing = 12
        column.setCustomSpacing(28, after: title)

        // The subscription, what it gives and what it is for, its button, then the free call under it.
        let footer = UIStackView()
        footer.axis = .vertical
        footer.spacing = 12
        if case .preview(let price) = offer, let subscribe {
            let heading = StyledLabel(style: Self.offerStyle, color: Palette.startText, alignment: .center)
            heading.string = Strings.Call.supportFor(price)
            let support = StyledLabel(style: Self.detailStyle, color: Palette.startTextSecondary, alignment: .center)
            support.decoration = StartGalleryView.noOrphan
            support.string = Strings.Call.subscribeSupport
            let allowance = StyledLabel(style: Self.detailStyle, color: Palette.startText, alignment: .center)
            allowance.string = Strings.Call.subscribeAllowance
            footer.addArrangedSubview(heading)
            footer.setCustomSpacing(2, after: heading)
            footer.addArrangedSubview(allowance)
            footer.setCustomSpacing(6, after: allowance)
            footer.addArrangedSubview(support)
            footer.setCustomSpacing(20, after: support)
            subscribe.onTap = { [weak self] in self?.preview() }
            subscribe.accessibilityIdentifier = "call-sheet-subscribe"
            footer.addArrangedSubview(centred(subscribe, width: Metrics.button))
        }
        footer.addArrangedSubview(centred(session, width: Metrics.button))
        footer.addArrangedSubview(note)
        session.accessibilityIdentifier = "call-sheet-session"
        var notes: [String] = []
        switch screen {
        case .welcome:
            session.addAction(UIAction { [weak self] _ in self?.start() }, for: .touchUpInside)
        case .used:
            session.isEnabled = false
        }
        if offer.onSale { notes.append(Strings.Call.upgradePreviewNote) }
        note.string = notes.joined(separator: "\n")
        note.isHidden = notes.isEmpty

        var cross = UIButton.Configuration.filled()
        cross.image = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .bold))
        cross.baseBackgroundColor = UIColor(Palette.startText).withAlphaComponent(0.1)
        cross.baseForegroundColor = UIColor(Palette.startText)
        cross.cornerStyle = .capsule
        cross.background.backgroundInsets = NSDirectionalEdgeInsets(top: 6, leading: 6, bottom: 6, trailing: 6)
        close.configuration = cross
        close.accessibilityLabel = Strings.Call.close
        close.accessibilityIdentifier = "call-sheet-close"
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
        let content = scroll.contentLayoutGuide
        let frame = scroll.frameLayoutGuide
        // The screen's height, taller once the words are.
        let fit = content.heightAnchor.constraint(equalTo: frame.heightAnchor)
        fit.priority = .defaultLow
        let upper = UILayoutGuide()
        scroll.addLayoutGuide(upper)
        // The actions as short as their words, the space left above them,
        // and the column in its middle where there is room.
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
            // 44 points to touch, the circle drawn inside.
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
        // Still with Reduce Motion: the mic as it stands mid-way.
        if UIAccessibility.isReduceMotionEnabled { mic.currentProgress = 0.5 } else { mic.play() }
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
        if let width { constraints.append(view.widthAnchor.constraint(equalToConstant: width).withPriority(.defaultHigh)) }
        if let height { constraints += [view.heightAnchor.constraint(equalToConstant: height), view.widthAnchor.constraint(equalToConstant: height)] }
        NSLayoutConstraint.activate(constraints)
        return holder
    }

    /// The mic, gunzipped from the `.tgs` it came as (`Animations/PROVENANCE.md`).
    private static let micAnimation: LottieAnimation? = {
        guard let url = Bundle.module.url(forResource: "podcast-mic", withExtension: "json")
            ?? Bundle.module.url(forResource: "podcast-mic", withExtension: "json", subdirectory: "Animations"),
            let data = try? Data(contentsOf: url) else { return nil }
        return try? LottieAnimation.from(data: data)
    }()

    /// When free time is back, as a sentence ends it: "at 5:19 PM" today,
    /// "on Thu at 5:19 PM" this week, "on Dec 3" after.
    static func when(_ date: Date, now: Date) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        let calendar = Calendar.current
        if calendar.isDate(date, inSameDayAs: now) { return Strings.Call.at(time) }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        if days < 7 { return Strings.Call.on(Strings.Call.at(time, day: date.formatted(.dateTime.weekday(.abbreviated)))) }
        return Strings.Call.on(date.formatted(.dateTime.month(.abbreviated).day()))
    }

    private func start() {
        let onStart = onStart
        dismiss(animated: true) { onStart?() }
    }

    /// Debug builds' test preview: what subscribing would say, said plainly
    /// as nothing. No product, charge, grant or change to the free time.
    private func preview() {
        let alert = UIAlertController(title: Strings.Call.upgradePreviewTitle, message: Strings.Call.upgradePreviewMessage, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Call.ok, style: .default))
        present(alert, animated: true)
    }

    /// In a full-height sheet of its own over whatever is on top.
    @discardableResult
    static func present(_ screen: Screen, over top: UIViewController, onStart: (() -> Void)? = nil) -> CallSheetViewController {
        let sheet = CallSheetViewController(screen)
        sheet.onStart = onStart
        sheet.modalPresentationStyle = .pageSheet
        sheet.sheetPresentationController?.detents = [.large()]
        sheet.sheetPresentationController?.preferredCornerRadius = 28
        top.present(sheet, animated: true)
        return sheet
    }
}

private extension NSLayoutConstraint {
    func withPriority(_ priority: UILayoutPriority) -> NSLayoutConstraint {
        self.priority = priority
        return self
    }
}

/// One thing voice does, on the gradient: its symbol and a few words, and
/// a warning under them if there is one.
private final class Benefit: UIView {
    init(symbol: String, title: String, warning: String? = nil) {
        super.init(frame: .zero)
        isAccessibilityElement = true
        accessibilityLabel = [title, warning].compactMap { $0 }.joined(separator: ". ")
        let icon = UIImageView(image: UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .medium)))
        icon.tintColor = UIColor(Palette.startText)
        icon.contentMode = .center
        let words = StyledLabel(style: CallSheetViewController.rowStyle, color: Palette.startText)
        words.string = title
        let text = UIStackView(arrangedSubviews: [words])
        text.axis = .vertical
        text.spacing = 4
        if let warning {
            let line = StyledLabel(style: CallSheetViewController.detailStyle, color: Palette.warningText)
            line.string = warning
            text.addArrangedSubview(line)
        }
        for view in [icon, text] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor),
            icon.centerYAnchor.constraint(equalTo: words.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 28),
            icon.heightAnchor.constraint(equalToConstant: 24),
            text.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 14),
            text.trailingAnchor.constraint(equalTo: trailingAnchor),
            text.topAnchor.constraint(equalTo: topAnchor),
            text.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
}

/// "Start Voice Session" with the voice button's bars after it: the
/// splash's pill when it is the main action, a quiet one under the
/// subscription otherwise.
final class SessionButton: UIControl {
    private let background = UIView()

    init(title: String, prominent: Bool) {
        super.init(frame: .zero)
        let style = TextStyles.roundButton(.large, display: .filled)
        let ink = prominent ? Palette.roundButtonText : Palette.startText
        background.backgroundColor = prominent ? UIColor(Palette.roundButtonFill) : UIColor(Palette.startText).withAlphaComponent(0.1)
        background.isUserInteractionEnabled = false
        let label = StyledLabel(style: style, color: ink, lines: 0, alignment: .center)
        label.string = title
        let icon = UIImageView(image: .voiceIcon(size: 20))
        icon.tintColor = UIColor(ink)
        icon.contentMode = .center
        let row = UIStackView(arrangedSubviews: [label, icon])
        row.spacing = 8
        row.alignment = .center
        row.isUserInteractionEnabled = false
        for view in [background, row] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        NSLayoutConstraint.activate([
            background.topAnchor.constraint(equalTo: topAnchor),
            background.bottomAnchor.constraint(equalTo: bottomAnchor),
            background.leadingAnchor.constraint(equalTo: leadingAnchor),
            background.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.centerXAnchor.constraint(equalTo: centerXAnchor),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
            row.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
            row.topAnchor.constraint(greaterThanOrEqualTo: topAnchor, constant: 12),
            heightAnchor.constraint(greaterThanOrEqualToConstant: RoundButtonMetrics.of(.large).height),
        ])
        isAccessibilityElement = true
        accessibilityLabel = title
        accessibilityTraits = .button
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        background.layer.cornerRadius = bounds.height / 2
    }

    override var isHighlighted: Bool {
        didSet { background.alpha = isHighlighted ? 0.7 : 1 }
    }

    override var isEnabled: Bool {
        didSet {
            alpha = isEnabled ? 1 : 0.4
            accessibilityTraits = isEnabled ? .button : [.button, .notEnabled]
        }
    }
}
#endif
