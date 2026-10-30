#if canImport(UIKit)
import HappyLayout
import UIKit

/// A conversation's title in the navigation bar (`navigationItem.titleView`):
/// its name, with the connection or agent's activity always under it. A
/// tap anywhere on it opens the conversation's detail. Frames are
/// `ChatHeaderLayout`'s.
@MainActor
final class ChatHeaderView: UIView {
    let titleView = ChatTitleView()
    /// The title was tapped: the detail opens.
    var onOpen: (() -> Void)? {
        didSet { titleView.onOpen = onOpen }
    }

    /// The connection or what the agent is doing, always under its name.
    var status: String = Strings.HeaderStatus.text(.connecting) {
        didSet {
            guard status != oldValue else { return }
            HeaderStatusTransition.apply(to: statusLabel) { [self] in statusLabel.text = status }
        }
    }

    /// The widest the title may be in the bar it is in.
    var maxWidth: CGFloat = .greatestFiniteMagnitude {
        didSet {
            guard maxWidth != oldValue else { return }
            titleView.maxWidth = maxWidth
            resize()
        }
    }

    private let statusLabel = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        titleView.isUserInteractionEnabled = false
        addSubview(titleView)
        statusLabel.font = LegacyFonts.font(.regular, size: 13)
        statusLabel.textColor = UIColor(Palette.textSecondary)
        statusLabel.textAlignment = .center
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.text = status
        statusLabel.accessibilityIdentifier = "chat-status"
        addSubview(statusLabel)
        accessibilityIdentifier = "chat-capsule"
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(open)))
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    @objc private func open() { onOpen?() }

    private var layout: ChatHeaderLayout {
        // Reserve the widest status once; changing words moves no frame.
        return ChatHeaderLayout(titleWidth: titleView.intrinsicContentSize.width, statusWidth: reservedStatusWidth,
                                maxWidth: maxWidth == .greatestFiniteMagnitude ? 10_000 : maxWidth)
    }

    private lazy var reservedStatusWidth: CGFloat = Strings.HeaderStatus.all.map {
        ($0 as NSString).size(withAttributes: [.font: statusLabel.font!]).width
    }.max() ?? 0

    override var intrinsicContentSize: CGSize { layout.size }

    override func sizeThatFits(_ size: CGSize) -> CGSize { layout.size }

    /// The name or the status changed width: the bar places it again.
    func resize() {
        invalidateIntrinsicContentSize()
        frame.size = layout.size
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout
        // The name's own box is the bar's 44: centred on its line.
        let height = ChatTitleLayout.height
        titleView.frame = CGRect(x: layout.title.minX, y: layout.title.midY - height / 2, width: layout.title.width, height: height)
        statusLabel.frame = layout.status ?? .zero
        statusLabel.isHidden = layout.status == nil
    }
}
#endif
