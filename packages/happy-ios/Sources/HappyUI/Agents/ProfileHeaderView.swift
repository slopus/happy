#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A chat's profile's head, the agent chat's (`SessionDetailViewController`)
/// and the legacy session's (`SessionInfoViewController`) alike: its avatar
/// large, the one home draws for the same chat; its name, with the pencil
/// that renames it where it can be; what it is and its status under that.
/// It spans the top of its screen's scroll, so its frames are
/// `ProfileHeaderLayout`'s as they stand.
final class ProfileHeaderView: UIView {
    enum Avatar: Equatable {
        /// An agent chat's: the mark its home row wears
        /// (`SidebarRows.profileMark`).
        case mark(Row.Mark)
        /// A legacy session's, as home's row and the chat's header draw it.
        case session(AvatarView.Content)
    }

    var avatar: Avatar? {
        didSet { if avatar != oldValue { applyAvatar() } }
    }
    /// What an agent's picture is read with.
    var images: Images? {
        get { mark.images }
        set { mark.images = newValue }
    }
    /// What a session's picture is read with.
    var pictures: AvatarPictures? {
        didSet { sessionAvatar?.pictures = pictures }
    }

    let mark = DetailMarkView()
    /// Made for the first session avatar.
    private(set) var sessionAvatar: AvatarView?
    let name = UILabel()
    let pencil = UIButton(type: .system)
    let subtitle = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(mark)
        name.font = Fonts.ui(.medium, size: 28)
        name.textColor = UIColor(Palette.settingsText)
        name.textAlignment = .center
        name.lineBreakMode = .byTruncatingTail
        name.accessibilityIdentifier = "detail-name"
        name.accessibilityTraits = .header
        addSubview(name)
        pencil.setImage(Glyphs.image("pencil", size: 16), for: .normal)
        pencil.tintColor = UIColor(Palette.settingsSecondary)
        pencil.accessibilityLabel = Strings.rename
        pencil.accessibilityIdentifier = "detail-rename-button"
        pencil.isHidden = true
        addSubview(pencil)
        subtitle.font = Fonts.ui(.regular, size: 17)
        subtitle.textColor = UIColor(Palette.settingsSecondary)
        subtitle.textAlignment = .center
        subtitle.accessibilityIdentifier = "detail-subtitle"
        addSubview(subtitle)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// The layout's inputs this head measures: its name's line and width,
    /// its subtitle's line.
    var nameHeight: CGFloat { ceil(name.font.lineHeight) }
    var nameWidth: CGFloat { name.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: name.font.lineHeight)).width }
    var subtitleHeight: CGFloat { ceil(subtitle.font.lineHeight) }

    /// Where the layout puts it, the pencil shown where it renames.
    func place(_ layout: ProfileHeaderLayout, width: CGFloat, editing: Bool = false) {
        let frame = CGRect(x: 0, y: 0, width: width, height: layout.bottom)
        if self.frame != frame { self.frame = frame }
        mark.frame = layout.mark
        sessionAvatar?.frame = layout.mark
        name.frame = layout.name
        pencil.isHidden = layout.pencilTouch == nil || editing
        if let touch = layout.pencilTouch { pencil.frame = touch }
        subtitle.frame = layout.subtitle
    }

    private func applyAvatar() {
        switch avatar {
        case .mark(let shown)?:
            mark.isHidden = false
            mark.mark = shown
            sessionAvatar?.isHidden = true
            sessionAvatar?.content = nil
        case .session(let content)?:
            mark.isHidden = true
            mark.mark = .none
            let view = sessionAvatar ?? {
                let view = AvatarView(frame: mark.frame)
                view.accessibilityIdentifier = "detail-avatar"
                view.pictures = pictures
                addSubview(view)
                sessionAvatar = view
                return view
            }()
            view.isHidden = false
            view.content = content
        case nil:
            mark.isHidden = true
            sessionAvatar?.isHidden = true
        }
    }

    /// The name and the pencil take their taps; the rest is the screen's.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        name.frame.contains(point) || (!pencil.isHidden && pencil.frame.contains(point))
    }
}
#endif
