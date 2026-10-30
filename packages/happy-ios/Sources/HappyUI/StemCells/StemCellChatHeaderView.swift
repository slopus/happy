#if canImport(UIKit)
import HappyLayout
import UIKit

/// A conversation's title in the navigation bar (`navigationItem.titleView`):
/// its name, with the agent's status in grey under it while it works. A
/// tap anywhere on it opens the conversation's detail. Frames are
/// `StemCellChatHeaderLayout`'s.
@MainActor
final class StemCellChatHeaderView: UIView {
    let titleView = StemCellChatTitleView()
    /// The title was tapped: the detail opens.
    var onOpen: (() -> Void)? {
        didSet { titleView.onOpen = onOpen }
    }

    /// What the agent is doing, under its name; nil for nothing.
    var status: String? {
        didSet {
            guard status != oldValue else { return }
            statusLabel.text = status
            resize()
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
        statusLabel.font = Fonts.font(.regular, size: 13)
        statusLabel.textColor = UIColor(Palette.textSecondary)
        statusLabel.textAlignment = .center
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.isHidden = true
        statusLabel.accessibilityIdentifier = "stem-chat-status"
        addSubview(statusLabel)
        accessibilityIdentifier = "stem-chat-capsule"
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(open)))
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    @objc private func open() { onOpen?() }

    private var layout: StemCellChatHeaderLayout {
        // While the name is being typed it has the bar to itself.
        let statusWidth = status == nil || titleView.isEditing ? nil : statusLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 16)).width
        return StemCellChatHeaderLayout(titleWidth: titleView.intrinsicContentSize.width, statusWidth: statusWidth, maxWidth: maxWidth == .greatestFiniteMagnitude ? 10_000 : maxWidth)
    }

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
        let height = StemCellChatTitleLayout.height
        titleView.frame = CGRect(x: layout.title.minX, y: layout.title.midY - height / 2, width: layout.title.width, height: height)
        statusLabel.frame = layout.status ?? .zero
        statusLabel.isHidden = layout.status == nil
    }
}
#endif
