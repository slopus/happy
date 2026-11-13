#if canImport(UIKit)
import HappyLayout
import UIKit

/// The photo editor's glass buttons (Telegram's `GlassBarButtonComponent`):
/// a 44 circle with a glyph, a pill with a title, or the accent's done.
final class PhotoEditorButton: UIControl {
    enum Content {
        case symbol(String)
        case title(String)
    }

    private let glass: UIVisualEffectView
    private let glyph = UIImageView()
    private let title = UILabel()
    private let content: Content
    private let accent: Bool
    /// Its edit applied: the glyph turns Telegram's yellow.
    var applied = false { didSet { tint() } }
    /// Opened from it on a tap, instead of its action (Clear's confirmation).
    var menu: UIMenu? {
        didSet {
            isContextMenuInteractionEnabled = menu != nil
            showsMenuAsPrimaryAction = menu != nil
        }
    }

    init(_ content: Content, accent: Bool = false, glass: Bool = true, identifier: String, label: String? = nil) {
        self.content = content
        self.accent = accent
        let effect: UIGlassEffect? = glass ? {
            let effect = UIGlassEffect(style: .regular)
            effect.isInteractive = true
            if accent { effect.tintColor = PhotoEditorButton.accentFill }
            return effect
        }() : nil
        self.glass = UIVisualEffectView(effect: effect)
        super.init(frame: .zero)
        overrideUserInterfaceStyle = .dark
        accessibilityIdentifier = identifier
        isAccessibilityElement = true
        accessibilityTraits = .button
        self.glass.isUserInteractionEnabled = false
        addSubview(self.glass)
        switch content {
        case let .symbol(name):
            let artwork = ["crop.rotate": "Crop", "pencil.tip.crop.circle": "Pencil", "rotate.left": "Rotate", "arrow.left.and.right.righttriangle.left.righttriangle.right": "Mirror", "aspectratio": "AspectRatio", "chevron.left": "Back", "xmark": "Close", "checkmark": "Done", "arrow.uturn.backward": "Undo", "arrow.uturn.forward": "Redo", "eyedropper": "Eyedropper"]
            if let asset = artwork[name] {
                glyph.image = UIImage(named: "PhotoEditor" + asset, in: .module, compatibleWith: nil)?.withRenderingMode(.alwaysTemplate)
                glyph.contentMode = .scaleAspectFit
            } else {
                glyph.image = UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .medium))
                glyph.contentMode = .center
            }
            self.glass.contentView.addSubview(glyph)
            accessibilityLabel = label
        case let .title(text):
            title.text = text
            title.font = .systemFont(ofSize: 17)
            self.glass.contentView.addSubview(title)
            accessibilityLabel = label ?? text
        }
        tint()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// The done button: the + sheet's accent as the day has it (the chat's
    /// send), light on the editor's black, its glyph dark.
    static var accentFill: UIColor { UIColor(Palette.attachMenuAccent).resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)) }
    static var onAccent: UIColor { UIColor(Palette.attachMenuOnAccent).resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)) }

    private func tint() {
        let color: UIColor = accent ? Self.onAccent : applied ? UIColor(Palette.photoEditorApplied) : UIColor(Palette.photoEditorControl)
        glyph.tintColor = color
        title.textColor = color
        accessibilityValue = applied ? Strings.PhotoEditor.applied : nil
    }

    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
        guard let menu else { return nil }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { _ in menu }
    }

    override var isEnabled: Bool {
        didSet { glass.contentView.alpha = isEnabled ? 1 : 0.4 }
    }

    override var isHighlighted: Bool {
        didSet { glyph.alpha = isHighlighted ? 0.6 : 1; title.alpha = glyph.alpha }
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        guard case .title = content else { return CGSize(width: 44, height: 44) }
        return CGSize(width: ceil(title.intrinsicContentSize.width) + 32, height: 44)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        glass.frame = bounds
        glass.cornerConfiguration = .capsule()
        glyph.frame = glyph.contentMode == .scaleAspectFit ? glass.contentView.bounds.insetBy(dx: 8, dy: 8) : glass.contentView.bounds
        title.sizeToFit()
        title.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }
}

/// Buttons side by side on one glass capsule (Telegram's toolbar group:
/// 44 each, 10 apart).
final class PhotoEditorGroup: UIView {
    private let glass: UIVisualEffectView = {
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = true
        return UIVisualEffectView(effect: effect)
    }()
    let buttons: [PhotoEditorButton]

    init(_ buttons: [PhotoEditorButton]) {
        self.buttons = buttons
        super.init(frame: .zero)
        overrideUserInterfaceStyle = .dark
        addSubview(glass)
        for button in buttons { addSubview(button) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func place(_ frames: [CGRect]) {
        glass.frame = bounds
        glass.cornerConfiguration = .capsule()
        for (button, frame) in zip(buttons, frames) { button.frame = frame }
    }
}

extension PhotoEditorButton {
    /// One of the group's: the glyph alone, the capsule its glass.
    static func plain(_ symbol: String, identifier: String, label: String) -> PhotoEditorButton {
        PhotoEditorButton(.symbol(symbol), glass: false, identifier: identifier, label: label)
    }
}

/// The editor's fades over the picture behind its controls
/// (`BlurredGradientComponent`): black at 35% at the edge, gone inward.
final class PhotoEditorShade: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }

    init(top: Bool) {
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        let gradient = layer as! CAGradientLayer
        let shade = UIColor(Palette.photoEditorShade)
        gradient.colors = [shade.cgColor, shade.withAlphaComponent(0).cgColor]
        gradient.startPoint = CGPoint(x: 0.5, y: top ? 0 : 1)
        gradient.endPoint = CGPoint(x: 0.5, y: top ? 1 : 0)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
}

/// The editor's screens come and go in a quick fade over the preview,
/// which shows the same picture in the same place.
final class PhotoEditorFade: NSObject, UIViewControllerAnimatedTransitioning, UIViewControllerTransitioningDelegate {
    private let opening: Bool

    init(opening: Bool) {
        self.opening = opening
    }

    static let shared = PhotoEditorFade(opening: true)

    func transitionDuration(using context: UIViewControllerContextTransitioning?) -> TimeInterval { AttachPreviewMotion.chrome }

    func animateTransition(using context: UIViewControllerContextTransitioning) {
        let duration = transitionDuration(using: context)
        if opening {
            guard let to = context.view(forKey: .to), let controller = context.viewController(forKey: .to) else { return context.completeTransition(false) }
            to.frame = context.finalFrame(for: controller)
            to.alpha = 0
            context.containerView.addSubview(to)
            UIView.animate(withDuration: duration, delay: 0, options: [.curveEaseOut]) { to.alpha = 1 } completion: { _ in
                context.completeTransition(!context.transitionWasCancelled)
            }
        } else {
            guard let from = context.view(forKey: .from) else { return context.completeTransition(false) }
            UIView.animate(withDuration: duration, delay: 0, options: [.curveEaseIn]) { from.alpha = 0 } completion: { _ in
                from.removeFromSuperview()
                context.completeTransition(!context.transitionWasCancelled)
            }
        }
    }

    func animationController(forPresented presented: UIViewController, presenting: UIViewController, source: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        PhotoEditorFade(opening: true)
    }

    func animationController(forDismissed dismissed: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        PhotoEditorFade(opening: false)
    }
}
#endif
