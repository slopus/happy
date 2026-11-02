#if canImport(UIKit)
import HappyLayout
import UIKit

/// A conversation's title in the navigation bar (`navigationItem.titleView`):
/// its name, with the connection or agent's activity always under it, on
/// one Liquid Glass capsule beside the bar's own glass buttons, as Telegram
/// heads a chat on iOS 26. A tap on the capsule opens the conversation's
/// detail.
///
/// The view takes all the room the bar leaves between its items, and
/// places the capsule in it itself (`ChatHeaderLayout`): Telegram's minimum
/// width, wider for a longer name, centred on the bar, moved aside only as far as an item makes it. UIKit
/// would centre a title view in whatever room is left, which a wide group
/// at the right pushes off the bar's middle.
@MainActor
final class ChatHeaderView: UIView {
    let titleView = ChatTitleView()

    /// The title was tapped: the detail opens.
    var onOpen: (() -> Void)? {
        didSet { titleView.onOpen = onOpen }
    }

    /// The connection or what the agent is doing, always under its name.
    /// Every status fits the capsule as it stands, so only the words
    /// crossfade.
    var status: String = Strings.HeaderStatus.text(.connecting) {
        didSet {
            guard status != oldValue else { return }
            setStatus(status, color: statusColor)
        }
    }

    /// The status's colour: the quiet grey, or a legacy session's tone
    /// (online, thinking, waiting on the person).
    private(set) var statusColor = UIColor(Palette.textSecondary)

    /// The words and their colour, crossfaded together.
    func setStatus(_ text: String, color: UIColor) {
        guard text != statusLabel.string || color != statusColor else { return }
        statusColor = color
        if status != text { status = text; return }
        HeaderStatusTransition.apply(to: statusLabel) { [self] in
            statusLabel.attributedText = NSAttributedString(string: text, attributes: [.font: Self.statusFont])
            statusLabel.textColor = color
        }
        statusWidth = width(of: text)
        HeaderStatusTransition.relayout(self)
    }

    /// Every status this header may say, the line kept as wide as the
    /// widest, with the spinner's room for those said with it: the
    /// agent's by default.
    var statuses: [String] = Strings.HeaderStatus.all {
        didSet { reservedStatusWidth = reserved(statuses); setNeedsLayout() }
    }

    private func reserved(_ statuses: [String]) -> CGFloat {
        let spinning = Set(Strings.HeaderStatus.spinning)
        let room = ChatHeaderLayout.Metrics.spinner + ChatHeaderLayout.Metrics.spinnerGap
        return statuses.map { width(of: $0) + (spinning.contains($0) ? room : 0) }.max() ?? 0
    }

    /// The status is the link on its way ("connecting…"): the spinner
    /// turns before it, fading in and out with the words.
    var statusSpins = false {
        didSet {
            guard statusSpins != oldValue else { return }
            if statusSpins { spinner.spins = true }
            HeaderStatusTransition.fade(spinner, to: statusSpins ? 1 : 0) { [weak self] in
                guard let self, !statusSpins else { return }
                spinner.spins = false
            }
            HeaderStatusTransition.relayout(self)
        }
    }
    let spinner = LinkSpinnerView(side: ChatHeaderLayout.Metrics.spinner)

    /// The widest the name may be in the bar it is in.
    var maxWidth: CGFloat = .greatestFiniteMagnitude {
        didSet {
            guard maxWidth != oldValue else { return }
            titleView.maxWidth = maxWidth
            resize()
        }
    }

    /// The glass the name and status sit on.
    let capsule = GlassCapsuleView(interactive: true)
    private let statusLabel = ShimmerLabel()
    private static var statusFont: UIFont { LegacyFonts.font(.regular, size: 13) }

    /// The status is work under way ("Thinking", "Working"): it carries
    /// the sheen, as desktop's working line's phase does.
    var statusShimmers = false {
        didSet { statusLabel.shimmering = statusShimmers }
    }

    /// The status's band is running (tests).
    var statusSweeps: Bool { statusLabel.band.sweeps }

    override init(frame: CGRect) {
        // Never zero wide: the bar doesn't look again at a title view that was.
        super.init(frame: CGRect(origin: frame.origin, size: CGSize(width: 1, height: ChatHeaderLayout.Metrics.height)))
        // Sized by the bar from `intrinsicContentSize`, not this frame: all
        // the room it has.
        translatesAutoresizingMaskIntoConstraints = false
        setContentHuggingPriority(.fittingSizeLevel, for: .horizontal)
        setContentCompressionResistancePriority(.fittingSizeLevel, for: .horizontal)
        capsule.accessibilityIdentifier = "chat-capsule"
        addSubview(capsule)
        titleView.isUserInteractionEnabled = false
        titleView.onResize = { [weak self] in
            self?.setNeedsLayout()
            self?.layoutIfNeeded()
        }
        capsule.contentView.addSubview(titleView)
        statusLabel.textColor = UIColor(Palette.textSecondary)
        statusLabel.alignment = .center
        statusLabel.attributedText = NSAttributedString(string: status, attributes: [.font: Self.statusFont])
        statusLabel.ground = UIColor(Palette.surface)
        statusLabel.textLabel.accessibilityIdentifier = "chat-status"
        capsule.contentView.addSubview(statusLabel)
        spinner.alpha = 0
        spinner.accessibilityIdentifier = "chat-status-spinner"
        capsule.contentView.addSubview(spinner)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(open)))
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    @objc private func open() { onOpen?() }

    private func width(of text: String) -> CGFloat {
        (text as NSString).size(withAttributes: [.font: Self.statusFont]).width
    }

    private lazy var statusWidth: CGFloat = width(of: status)

    /// The status's line is this wide whatever it says.
    private lazy var reservedStatusWidth: CGFloat = reserved(statuses)

    /// The bar's middle in this view: what the capsule centres on. Before
    /// the bar has it, this view's own.
    private var barCenterX: CGFloat {
        var ancestor = superview
        while let view = ancestor, !(view is UINavigationBar) { ancestor = view.superview }
        guard let bar = ancestor else { return bounds.midX }
        return convert(CGPoint(x: bar.bounds.midX, y: 0), from: bar).x
    }

    private var layout: ChatHeaderLayout {
        ChatHeaderLayout(
            titleWidth: titleView.intrinsicContentSize.width, statusWidth: statusWidth, reservedStatusWidth: reservedStatusWidth,
            spins: statusSpins, centerX: barCenterX, room: 0...max(0, bounds.width), height: bounds.height
        )
    }

    /// As wide as the bar lets a title view grow.
    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.layoutFittingExpandedSize.width, height: ChatHeaderLayout.Metrics.height)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        CGSize(width: size.width, height: ChatHeaderLayout.Metrics.height)
    }

    /// Moved in the bar without a new size: the bar's middle moved in it.
    override var center: CGPoint {
        didSet { if center != oldValue { setNeedsLayout() } }
    }

    /// The name changed width: the capsule is placed again.
    func resize() {
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout
        capsule.frame = layout.capsule
        let origin = layout.capsule.origin
        // The name's own box is the bar's 44: centred on its line.
        let height = ChatTitleLayout.height
        titleView.frame = CGRect(x: layout.title.minX, y: layout.title.midY - height / 2, width: layout.title.width, height: height)
            .offsetBy(dx: -origin.x, dy: -origin.y)
        statusLabel.frame = (layout.status ?? .zero).offsetBy(dx: -origin.x, dy: -origin.y)
        statusLabel.isHidden = layout.status == nil
        // Where it was while it fades away: the frame it last had.
        if let frame = layout.spinner { spinner.frame = frame.offsetBy(dx: -origin.x, dy: -origin.y) }
    }

    /// The capsule's glass through a push or pop of its screen, from the
    /// screen's `viewWillAppear` (`appearing`) and `viewWillDisappear`:
    /// the name and status go over as a plain title does, and the glass
    /// is there only while the screen stands still.
    ///
    /// iOS 26 morphs a bar item's glass into the next screen's (home's
    /// switcher into Back, its gear into Compose) but carries a title view
    /// across with the screen's content. The capsule's own glass went over
    /// as a second shape, on top of the switcher shrinking into Back and of
    /// the right button, and under the next screen's ground as it slid in
    /// (a hard edge across the capsule). A title view can't wear the bar's
    /// glass, and a bar item can't sit in the bar's middle (the bar ignores
    /// a fixed space's width, and a clear item before it goes through the
    /// morph as a dark rectangle), so the glass leaves for the transition:
    /// it goes as the transition starts and materializes once the screen
    /// has come, or come back from a swipe let go of.
    func ride(_ coordinator: UIViewControllerTransitionCoordinator?, appearing: Bool) {
        guard let coordinator, coordinator.isAnimated else {
            capsule.showsGlass = true
            return
        }
        // At once: the bar has a leaving title under the next screen's
        // right button within two frames, too soon for a dissolve to show.
        UIView.performWithoutAnimation { capsule.showsGlass = false }
        coordinator.animate(alongsideTransition: nil) { [weak self] context in
            // Shown now, or back from a swipe let go of: the glass comes
            // back. Gone or covered: it is back for whenever it shows.
            guard let self else { return }
            let shown = appearing != context.isCancelled
            guard shown, window != nil else {
                UIView.performWithoutAnimation { self.capsule.showsGlass = true }
                return
            }
            UIView.animate(withDuration: Self.glassMaterialize, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                self.capsule.showsGlass = true
            }
        }
    }

    /// How long the glass takes to come once its screen has come.
    static let glassMaterialize: TimeInterval = 0.3

    /// Only the capsule takes a touch; the bar around it stays the bar's.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        capsule.frame.contains(point)
    }
}
#endif
