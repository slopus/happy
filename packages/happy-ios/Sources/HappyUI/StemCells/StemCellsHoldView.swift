#if canImport(UIKit)
import HappyLayout
import UIKit

/// One thing a held row's menu does.
struct StemCellsMenuItem {
    var title: String
    var icon: String
    var destructive = false
    var run: () -> Void
}

/// What a hold on a sidebar row shows, as Telegram's chat list shows a held
/// chat (`ContextControllerImpl`, `ContextControllerExtractedPresentationNode`):
/// the screen blurred and dimmed, the row's conversation in a rounded card
/// grown out of the row, and the menu under it. A row without a preview is
/// lifted where it is with its menu beside it. A tap on the card opens the
/// row; a tap on an item does it once the overlay has gone; a tap anywhere
/// else puts it away.
final class StemCellsHoldOverlay: UIView {
    /// The card was tapped: the row opens under the overlay, which then fades.
    var onOpen: (() -> Void)?
    /// Going, however it goes: from here a new hold may open.
    var onLeave: (() -> Void)?
    /// Gone.
    var onClose: (() -> Void)?

    private let backdrop = UIVisualEffectView(effect: nil)
    private let dim = StemCellsHoldDim()
    private let card = UIView()
    private let menuView: StemCellsHoldMenuView
    private let preview: UIViewController?
    private weak var host: UIViewController?
    private let source: CGRect
    private var closing = false
    private var finished = false
    /// What runs once it is gone (a picked item).
    private var after: (() -> Void)?

    /// `source` is the row's frame in the window; `snapshot` the row drawn
    /// as it is, shown in its place when there is no preview. The overlay
    /// goes over the window's root controller, which holds the preview.
    init(window: UIWindow, items: [[StemCellsMenuItem]], preview: UIViewController?, source: CGRect, snapshot: UIView?) {
        self.preview = preview
        let host = window.rootViewController
        self.host = host
        self.source = source
        menuView = StemCellsHoldMenuView(items: items)
        super.init(frame: window.bounds)
        menuView.onPick = { [weak self] item in self?.close(animated: true) { item.run() } }
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        accessibilityViewIsModal = true
        backdrop.frame = bounds
        backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        dim.frame = bounds
        dim.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        dim.backgroundColor = UIColor(Palette.stemCellsHoldDim)
        dim.isAccessibilityElement = true
        dim.accessibilityLabel = Strings.StemCells.closeMenu
        dim.accessibilityTraits = .button
        dim.accessibilityIdentifier = "stem-hold-dismiss"
        addSubview(backdrop)
        addSubview(dim)
        dim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tappedAway)))
        // VoiceOver's tap would land on the card in front of it.
        dim.activate = { [weak self] in self?.tappedAway() }

        let insets = window.safeAreaInsets
        let cardSize = preview?.preferredContentSize
        let layout = StemCellsHoldLayout(screen: window.bounds.size, top: insets.top, bottom: insets.bottom, source: source, card: cardSize, menu: menuView.layout.size)
        card.frame = layout.card
        card.layer.cornerCurve = .continuous
        card.clipsToBounds = true
        if let preview {
            card.layer.cornerRadius = StemCellsHoldLayout.Metrics.cardCorner
            card.accessibilityIdentifier = "stem-preview-card"
            host?.addChild(preview)
            preview.view.frame = card.bounds
            preview.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            card.addSubview(preview.view)
            card.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tappedCard)))
            card.isAccessibilityElement = false
            card.accessibilityElements = [preview.view as Any]
        } else if let snapshot {
            card.layer.cornerRadius = StemCellsMetrics.cornerRadius
            card.backgroundColor = UIColor(Palette.stemCellsBackground)
            snapshot.frame = card.bounds
            card.addSubview(snapshot)
            card.isUserInteractionEnabled = false
        }
        menuView.frame = layout.menu
        addSubview(card)
        addSubview(menuView)
        let container = host?.view ?? window
        frame = container.convert(window.bounds, from: window)
        container.addSubview(self)
        if let host { preview?.didMove(toParent: host) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    // MARK: Motion

    /// Telegram's context spring (`makeSpringBounceAnimation`: mass 5,
    /// stiffness 900, damping 104), run to its settling time.
    private static func spring(_ keyPath: String, from: Any, to: Any, additive: Bool) -> CASpringAnimation {
        let animation = CASpringAnimation(keyPath: keyPath)
        animation.mass = 5
        animation.stiffness = 900
        animation.damping = 104
        animation.fromValue = from
        animation.toValue = to
        animation.isAdditive = additive
        animation.duration = animation.settlingDuration
        animation.timingFunction = CAMediaTimingFunction(name: .linear)
        return animation
    }

    private static func fade(_ layer: CALayer, from: Float, to: Float, duration: TimeInterval, delay: TimeInterval = 0, keep: Bool = false) {
        let animation = CABasicAnimation(keyPath: "opacity")
        animation.fromValue = from
        animation.toValue = to
        animation.duration = duration
        animation.beginTime = delay > 0 ? CACurrentMediaTime() + delay : 0
        animation.fillMode = .both
        animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        if keep { animation.isRemovedOnCompletion = false }
        layer.add(animation, forKey: "fade")
        layer.opacity = keep ? from : to
    }

    /// How far the card's centre is below the row's: what it grows out of.
    private var distance: CGFloat { preview == nil ? 0 : card.frame.midY - source.midY }

    /// The menu grows from its edge nearest the card.
    private var menuFrom: CGPoint {
        let direction: CGFloat = card.frame.minY < menuView.frame.minY ? -1 : 1
        return CGPoint(x: 0, y: -distance + direction * menuView.bounds.height / 2 - StemCellsHoldLayout.Metrics.spacing)
    }

    func present() {
        // The blur and dim in over 0.2 s; the card from the row and the menu
        // from the card, on Telegram's spring.
        backdrop.effect = UIBlurEffect(style: traitCollection.userInterfaceStyle == .dark ? .dark : .light)
        Self.fade(backdrop.layer, from: 0, to: 1, duration: 0.2)
        Self.fade(dim.layer, from: 0, to: 1, duration: 0.2)
        if preview != nil {
            Self.fade(card.layer, from: 0, to: 1, duration: 0.15)
            card.layer.add(Self.spring("position.y", from: -distance, to: 0, additive: true), forKey: "in-y")
            card.layer.add(Self.spring("transform.scale", from: 0.01, to: 1, additive: false), forKey: "in-scale")
        }
        Self.fade(menuView.layer, from: 0, to: 1, duration: 0.05)
        menuView.layer.add(Self.spring("transform.scale", from: 0.01, to: 1, additive: false), forKey: "in-scale")
        menuView.layer.add(Self.spring("position", from: NSValue(cgPoint: menuFrom), to: NSValue(cgPoint: .zero), additive: true), forKey: "in-position")
        UIAccessibility.post(notification: .screenChanged, argument: menuView)
    }

    /// Back into the row over 0.2 s, as Telegram's put away; `then` runs
    /// once gone. Asked again without animation while going, it goes at once.
    /// It keeps the touches it is given until gone, so none reach the list.
    func close(animated: Bool, duration: TimeInterval = 0.2, then: (() -> Void)? = nil) {
        guard !closing else {
            if !animated { finish() }
            return
        }
        closing = true
        after = then
        onLeave?()
        guard animated else { return finish() }
        // From wherever the way in has got to.
        func now<T>(_ layer: CALayer, _ keyPath: String, _ model: T) -> T {
            layer.presentation()?.value(forKeyPath: keyPath) as? T ?? model
        }
        let cardScale: CGFloat = now(card.layer, "transform.scale", 1)
        let cardY = now(card.layer, "position.y", card.layer.position.y) - card.layer.position.y
        let menuScale: CGFloat = now(menuView.layer, "transform.scale", 1)
        let menuAt: CGPoint = now(menuView.layer, "position", menuView.layer.position)
        let menuOffset = CGPoint(x: menuAt.x - menuView.layer.position.x, y: menuAt.y - menuView.layer.position.y)
        for layer in [card.layer, menuView.layer] {
            for key in ["in-y", "in-scale", "in-position"] { layer.removeAnimation(forKey: key) }
        }
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in self?.finish() }
        let ease = CAMediaTimingFunction(name: .easeInEaseOut)
        func move(_ layer: CALayer, _ keyPath: String, from: Any, to: Any, additive: Bool) {
            let animation = CABasicAnimation(keyPath: keyPath)
            animation.fromValue = from
            animation.toValue = to
            animation.isAdditive = additive
            animation.duration = duration
            animation.timingFunction = ease
            animation.fillMode = .forwards
            animation.isRemovedOnCompletion = false
            layer.add(animation, forKey: "out-\(keyPath)")
        }
        func fadeOut(_ layer: CALayer, _ duration: TimeInterval) {
            Self.fade(layer, from: now(layer, "opacity", layer.opacity), to: 0, duration: duration, keep: true)
        }
        fadeOut(backdrop.layer, duration)
        fadeOut(dim.layer, duration)
        if preview != nil {
            fadeOut(card.layer, duration * 0.8)
            move(card.layer, "position.y", from: cardY, to: -distance, additive: true)
            move(card.layer, "transform.scale", from: cardScale, to: 0.01, additive: false)
        } else {
            fadeOut(card.layer, duration)
        }
        fadeOut(menuView.layer, duration)
        move(menuView.layer, "transform.scale", from: menuScale, to: 0.01, additive: false)
        move(menuView.layer, "position", from: NSValue(cgPoint: menuOffset), to: NSValue(cgPoint: menuFrom), additive: true)
        CATransaction.commit()
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        if let preview {
            preview.willMove(toParent: nil)
            preview.view.removeFromSuperview()
            preview.removeFromParent()
        }
        removeFromSuperview()
        onClose?()
        after?()
        after = nil
    }

    @objc private func tappedAway() { close(animated: true) }

    /// The row opens under the card, which then fades into it.
    @objc private func tappedCard() {
        guard !closing else { return }
        closing = true
        onLeave?()
        onOpen?()
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in self?.finish() }
        for layer in [backdrop.layer, dim.layer, card.layer, menuView.layer] {
            Self.fade(layer, from: layer.presentation()?.opacity ?? 1, to: 0, duration: 0.2, keep: true)
        }
        CATransaction.commit()
    }

    override func accessibilityPerformEscape() -> Bool {
        close(animated: true)
        return true
    }
}

/// The dimmed screen behind the card: a tap, or VoiceOver's, puts it away.
private final class StemCellsHoldDim: UIView {
    var activate: (() -> Void)?

    override func accessibilityActivate() -> Bool {
        activate?()
        return true
    }
}

/// Telegram's action stack: the items over a blurred, tinted rounded
/// panel, an icon in its column and the title after it, groups parted by
/// a line.
final class StemCellsHoldMenuView: UIView {
    var onPick: ((StemCellsMenuItem) -> Void)?
    let layout: StemCellsHoldLayout.Menu
    private let items: [[StemCellsMenuItem]]
    private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
    private static let font = UIFont.systemFont(ofSize: 17)

    init(items: [[StemCellsMenuItem]]) {
        self.items = items
        let titles = items.map { group in group.map { ($0.title as NSString).size(withAttributes: [.font: Self.font]).width } }
        layout = StemCellsHoldLayout.Menu(titles: titles, titleHeight: Self.font.lineHeight)
        super.init(frame: CGRect(origin: .zero, size: layout.size))
        accessibilityIdentifier = "stem-hold-menu"
        layer.cornerRadius = layout.corner
        layer.cornerCurve = .continuous
        clipsToBounds = true
        blur.frame = bounds
        blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        blur.contentView.backgroundColor = UIColor(Palette.stemCellsHoldMenu)
        addSubview(blur)
        for line in layout.separators {
            let separator = UIView(frame: line)
            separator.backgroundColor = UIColor(Palette.stemCellsHoldSeparator)
            addSubview(separator)
        }
        for (group, frames) in zip(items, layout.items) {
            for (item, frame) in zip(group, frames) {
                addSubview(StemCellsHoldMenuItemView(item: item, frame: frame, font: Self.font) { [weak self] in self?.onPick?(item) })
            }
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
}

private final class StemCellsHoldMenuItemView: UIControl {
    private let pick: () -> Void
    private let highlight = UIView()

    init(item: StemCellsMenuItem, frame: StemCellsHoldLayout.Menu.Item, font: UIFont, pick: @escaping () -> Void) {
        self.pick = pick
        super.init(frame: frame.frame)
        let ink = UIColor(item.destructive ? Palette.stemCellsHoldDestructive : Palette.stemCellsHoldInk)
        highlight.frame = bounds
        highlight.backgroundColor = UIColor(Palette.stemCellsHoldHighlight)
        highlight.alpha = 0
        highlight.isUserInteractionEnabled = false
        addSubview(highlight)
        let origin = frame.frame.origin
        let icon = UIImageView(image: StemCellsGlyphs.image(item.icon, size: StemCellsHoldLayout.Metrics.iconSize).withRenderingMode(.alwaysTemplate))
        icon.tintColor = ink
        icon.contentMode = .center
        icon.frame = frame.icon.offsetBy(dx: -origin.x, dy: -origin.y)
        addSubview(icon)
        let title = UILabel(frame: frame.title.offsetBy(dx: -origin.x, dy: -origin.y))
        title.text = item.title
        title.font = font
        title.textColor = ink
        title.lineBreakMode = .byTruncatingTail
        addSubview(title)
        isAccessibilityElement = true
        accessibilityLabel = item.title
        accessibilityTraits = .button
        addAction(UIAction { [weak self] _ in self?.pick() }, for: .touchUpInside)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var isHighlighted: Bool {
        didSet { highlight.alpha = isHighlighted ? 1 : 0 }
    }
}
#endif
