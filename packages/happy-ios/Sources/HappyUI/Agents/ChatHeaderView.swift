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
/// places the capsule in it itself (`ChatHeaderLayout`): hugging its text,
/// centred on the bar, moved aside only as far as an item makes it. UIKit
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
    /// The capsule follows the word's width, about the bar's middle.
    var status: String = Strings.HeaderStatus.text(.connecting) {
        didSet {
            guard status != oldValue else { return }
            HeaderStatusTransition.apply(to: statusLabel) { [self] in statusLabel.text = status }
            statusWidth = width(of: status)
            HeaderStatusTransition.relayout(self)
        }
    }

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
    private let statusLabel = UILabel()

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
        statusLabel.font = LegacyFonts.font(.regular, size: 13)
        statusLabel.textColor = UIColor(Palette.textSecondary)
        statusLabel.textAlignment = .center
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.text = status
        statusLabel.accessibilityIdentifier = "chat-status"
        capsule.contentView.addSubview(statusLabel)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(open)))
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    @objc private func open() { onOpen?() }

    private func width(of text: String) -> CGFloat {
        (text as NSString).size(withAttributes: [.font: statusLabel.font!]).width
    }

    private lazy var statusWidth: CGFloat = width(of: status)

    /// The status's line is this wide whatever it says.
    private lazy var reservedStatusWidth: CGFloat = Strings.HeaderStatus.all.map { width(of: $0) }.max() ?? 0

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
            centerX: barCenterX, room: 0...max(0, bounds.width), height: bounds.height
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
    }

    /// Only the capsule takes a touch; the bar around it stays the bar's.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        capsule.frame.contains(point)
    }
}
#endif
