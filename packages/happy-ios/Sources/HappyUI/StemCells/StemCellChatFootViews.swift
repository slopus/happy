#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Desktop's way back to the newest message (`.happy-message-list__jump`):
/// a small secondary circle with the arrow down, its hairline and soft
/// shadow, shown while the reader is away from the end. While the agent
/// works its arrow carries the sheen every working thing in the app does
/// (`StemCellsShimmerLabel`). Its touch reaches past the drawn 32 to 44.
final class StemCellChatJumpButton: UIControl {
    private let arrow = StemCellsShimmerLabel()

    /// Desktop's rule: the arrow shimmers while the working line's
    /// loader runs, not on a question waiting on the person or a
    /// scheduled wait, which the line shows still.
    static func spins(_ activity: StemCellActivity?) -> Bool {
        guard let activity else { return false }
        switch activity.phase {
        case .awaitingAnswer, .waiting: return false
        default: return true
        }
    }

    var working = false {
        didSet {
            arrow.shimmering = working
            accessibilityValue = working ? Strings.StemCells.jumpWorking : Strings.StemCells.jumpIdle
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        typealias M = StemCellChatFootLayout.Metrics
        backgroundColor = UIColor(Palette.surfaceHigh)
        layer.cornerRadius = M.jumpSize / 2
        layer.borderWidth = 1
        layer.shadowOffset = CGSize(width: 0, height: M.jumpShadowOffset)
        layer.shadowRadius = M.jumpShadowRadius
        layer.shadowOpacity = Float(M.jumpShadowOpacity)
        // Desktop's band is 15% of the arrow into the page's surface.
        arrow.ground = UIColor(Palette.surface)
        arrow.textColor = UIColor(Palette.text)
        // The arrow as the line's one character, centred on the line.
        let font = UIFont.systemFont(ofSize: 17)
        let attachment = NSTextAttachment(image: StemCellsGlyphs.image("arrow-down-outline", size: M.jumpIcon))
        attachment.bounds = CGRect(x: 0, y: (font.ascender + font.descender - M.jumpIcon) / 2, width: M.jumpIcon, height: M.jumpIcon)
        let line = NSMutableAttributedString(attachment: attachment)
        line.addAttribute(.font, value: font, range: NSRange(location: 0, length: line.length))
        arrow.attributedText = line
        addSubview(arrow)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = Strings.StemCells.jumpToLatest
        accessibilityIdentifier = "stem-jump-latest"
        accessibilityValue = Strings.StemCells.jumpIdle
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func applyColors() {
        layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
        layer.shadowColor = UIColor(Palette.shadow).resolvedColor(with: traitCollection).cgColor
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let icon = StemCellChatFootLayout.Metrics.jumpIcon
        arrow.frame = CGRect(x: ((bounds.width - icon) / 2).rounded(), y: 0, width: icon, height: bounds.height)
        layer.shadowPath = UIBezierPath(ovalIn: bounds).cgPath
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.insetBy(dx: -6, dy: -6).contains(point)
    }

    override var isHighlighted: Bool {
        didSet { arrow.alpha = isHighlighted ? 0.6 : 1 }
    }
}

/// The conversation's ground from just above the composer to the foot of
/// the screen, coming in over the list's gap above the card: the
/// transcript passes behind it, so nothing of it shows under the card,
/// beside it, or through its glass.
final class StemCellChatGroundView: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }

    /// The share of the height, from the top, the ground fades in over.
    var fadeShare: CGFloat = 0 {
        didSet { if fadeShare != oldValue { update() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        update()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.update() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func update() {
        guard let gradient = layer as? CAGradientLayer else { return }
        let ground = UIColor(Palette.surface).resolvedColor(with: traitCollection)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        gradient.colors = [ground.withAlphaComponent(0).cgColor, ground.cgColor, ground.cgColor]
        gradient.locations = [0, NSNumber(value: Double(fadeShare)), 1]
        CATransaction.commit()
    }
}
#endif
