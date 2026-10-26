#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// A conversation's header, as Telegram's on iOS 26: a glass back circle
/// and the name in a glass capsule, with the agent's status in grey under
/// it, floating over the transcript, which scrolls under them and a scrim.
/// The capsule renames where it stands (`StemCellChatTitleView`). Frames
/// are `StemCellChatHeaderLayout`'s. Touches between the controls go
/// through to the transcript.
@MainActor
final class StemCellChatHeaderView: UIView {
    let titleView = StemCellChatTitleView()
    var onBack: (() -> Void)?

    /// What the agent is doing, under its name; nil for nothing.
    var status: String? {
        didSet {
            guard status != oldValue else { return }
            statusLabel.text = status
            setNeedsLayout()
        }
    }

    /// The status bar's height: the row starts under it.
    var safeTop: CGFloat = 0 {
        didSet { if safeTop != oldValue { setNeedsLayout() } }
    }

    private let scrim = HeaderScrimView()
    private let backGlass = StemCellChatHeaderView.glass()
    private let backButton = UIButton(type: .system)
    private let pillGlass = StemCellChatHeaderView.glass()
    private let statusLabel = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(scrim)
        backButton.setImage(.icon(.ionicons("chevron-back"), size: 28), for: .normal)
        backButton.tintColor = UIColor(Palette.headerTint)
        backButton.accessibilityLabel = Strings.StemCells.back
        backButton.accessibilityIdentifier = "stem-chat-back"
        backButton.addAction(UIAction { [weak self] _ in self?.onBack?() }, for: .touchUpInside)
        backGlass.contentView.addSubview(backButton)
        addSubview(backGlass)
        // Anywhere on the capsule is the name's.
        pillGlass.addGestureRecognizer(UITapGestureRecognizer(target: titleView, action: #selector(StemCellChatTitleView.beginEditing)))
        addSubview(pillGlass)
        addSubview(titleView)
        statusLabel.font = .systemFont(ofSize: 13)
        statusLabel.textColor = UIColor(Palette.textSecondary)
        statusLabel.textAlignment = .center
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.isHidden = true
        statusLabel.accessibilityIdentifier = "stem-chat-status"
        addSubview(statusLabel)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    static func glass() -> UIVisualEffectView {
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = true
        return UIVisualEffectView(effect: effect)
    }

    var layout: StemCellChatHeaderLayout {
        // While the name is being typed it has the capsule to itself.
        let statusWidth = status == nil || titleView.isEditing ? nil : statusLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 16)).width
        return StemCellChatHeaderLayout(width: bounds.width, safeTop: safeTop, titleWidth: titleView.intrinsicContentSize.width, statusWidth: statusWidth)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // The name is bounded by the capsule, whatever it says.
        titleView.maxWidth = StemCellChatHeaderLayout(width: bounds.width, safeTop: safeTop, titleWidth: 0, statusWidth: nil).titleMaxWidth
        let layout = layout
        scrim.frame = layout.backdrop
        backGlass.frame = layout.back
        backGlass.cornerConfiguration = .corners(radius: .fixed(Double(layout.back.height / 2)))
        backButton.frame = backGlass.bounds
        pillGlass.frame = layout.pill
        pillGlass.cornerConfiguration = .corners(radius: .fixed(Double(layout.pill.height / 2)))
        // The name's own box is a bar's 44: centred on its line.
        let height = StemCellChatTitleLayout.height
        titleView.frame = CGRect(x: layout.title.minX, y: layout.title.midY - height / 2, width: layout.title.width, height: height)
        statusLabel.frame = layout.status ?? .zero
        statusLabel.isHidden = layout.status == nil
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self || hit === scrim ? nil : hit
    }
}
#endif
