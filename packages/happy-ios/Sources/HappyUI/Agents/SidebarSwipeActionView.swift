#if canImport(UIKit)
import HappyLayout
import UIKit

/// The red action a home row's swipe uncovers inside its card: the
/// archive glyph over its title, in white. Where it and its label stand is
/// `SidebarSwipeLayout`'s.
@MainActor
final class SidebarSwipeActionView: UIView {
    private let icon = UIImageView()
    let title = UILabel()
    static let iconSize = CGSize(width: 22, height: 22)

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = UIColor(Palette.statusError)
        icon.image = UIImage.icon(.ionicons("archive-outline"), size: 20).withRenderingMode(.alwaysTemplate)
        icon.tintColor = .white
        icon.contentMode = .center
        title.text = Strings.archive
        title.font = Fonts.ui(.semiBold, size: 13)
        title.textColor = .white
        addSubview(icon)
        addSubview(title)
        // The row's own custom action says it to VoiceOver.
        accessibilityElementsHidden = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// The title's size.
    var titleSize: CGSize {
        let size = title.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        return CGSize(width: ceil(size.width), height: ceil(size.height))
    }

    func apply(_ frames: SidebarSwipeLayout.Frames) {
        frame = frames.action
        icon.frame = frames.icon
        title.frame = frames.title
    }
}
#endif
