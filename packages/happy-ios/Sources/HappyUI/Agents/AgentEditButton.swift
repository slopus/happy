#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The agent's own picture, large and centred at the top of its
/// connection's Settings: a circle, or the desktop glyph on the accounts
/// card's blue without one, with a small pencil badge on its rim made of
/// the system's Liquid Glass (`UIGlassEffect`). A press opens its native
/// menu from it, "Change avatar" and "Edit name". Each asks the agent in
/// Happy's conversation; nothing here changes the agent itself
/// (`ChiefOfStaffAsk`).
final class AgentEditButton: UIButton {
    private let avatar = UIImageView()
    private let badge = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
    private let pencil = UIImageView(image: Glyphs.image("pencil", size: AgentEditButtonLayout.Metrics.pencil))
    private let layoutFrames = AgentEditButtonLayout()

    /// The agent's picture; nil shows the desktop glyph.
    var picture: UIImage? {
        didSet { if picture !== oldValue { showPicture() } }
    }

    /// What each menu item asks for.
    var ask: (@MainActor (ChatPrefill) -> Void)?

    /// What the badge shows, for the raster test.
    var badgeView: UIView { badge }

    override init(frame: CGRect) {
        super.init(frame: CGRect(origin: frame.origin, size: AgentEditButtonLayout().size))
        avatar.clipsToBounds = true
        avatar.isUserInteractionEnabled = false
        addSubview(avatar)
        badge.isUserInteractionEnabled = false
        pencil.tintColor = UIColor(Palette.settingsText)
        pencil.contentMode = .center
        badge.contentView.addSubview(pencil)
        addSubview(badge)
        showsMenuAsPrimaryAction = true
        menu = Self.menu { [weak self] in self?.ask?($0) }
        accessibilityIdentifier = "settings-agent-menu"
        accessibilityLabel = Strings.AgentMenu.button
        showPicture()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: CGSize { layoutFrames.size }
    override func sizeThatFits(_ size: CGSize) -> CGSize { layoutFrames.size }

    override func layoutSubviews() {
        super.layoutSubviews()
        avatar.frame = layoutFrames.avatar
        avatar.layer.cornerRadius = layoutFrames.avatar.height / 2
        badge.frame = layoutFrames.badge
        badge.cornerConfiguration = .corners(radius: .fixed(Double(layoutFrames.badge.height / 2)))
        pencil.frame = layoutFrames.pencil
    }

    private func showPicture() {
        if let picture {
            avatar.image = picture
            avatar.contentMode = .scaleAspectFill
            avatar.backgroundColor = nil
        } else {
            avatar.image = Glyphs.image("desktop-outline", size: AgentEditButtonLayout.Metrics.fallbackGlyph)
            avatar.contentMode = .center
            // As the accounts card draws a computer: white on its blue tile.
            avatar.tintColor = UIColor(Palette.settingsGlyph)
            avatar.backgroundColor = UIColor(SettingsCardView.RowView.color(.blue))
        }
    }

    static func menu(_ ask: @escaping @MainActor (ChatPrefill) -> Void) -> UIMenu {
        UIMenu(children: [
            UIAction(title: Strings.AgentMenu.changeAvatar, image: Glyphs.image("image-outline", size: 20), identifier: .init("agent-change-avatar")) { _ in ask(.agentAvatar) },
            UIAction(title: Strings.AgentMenu.editName, image: Glyphs.image("pencil", size: 20), identifier: .init("agent-edit-name")) { _ in ask(.agentName) },
        ])
    }
}
#endif
