#if canImport(UIKit)
import HappyLayout
import UIKit

/// Telegram's glass panel at the foot of the "+" menu (`AttachmentPanel`,
/// glass): a capsule of tabs with a lens behind the chosen one that a
/// finger can drag along the bar (`TabSelectionRecognizer`), which turns,
/// while photos are picked, into the caption: the chat's own composer card
/// (`AgentInputCardView`) with only its text and send, so the two look
/// the same; the tabs' glass dematerializes as the card fades in.
///
/// The lens is Telegram's own for systems without the private liquid lens
/// (`LiquidLensView`'s legacy selection): a tinted capsule 3 in, the chosen
/// tab's glyph and name in full ink inside it, 2 bigger while a finger
/// holds it.
@MainActor
final class AttachMenuPanel: UIView, UIGestureRecognizerDelegate {
    var onTab: ((Int) -> Void)?
    var onSend: (() -> Void)?
    /// The caption took or gave up the keyboard.
    var onFocus: ((Bool) -> Void)?
    var onCaption: ((String) -> Void)?
    /// The caption grew or shrank: the panel wants placing again.
    var onResize: (() -> Void)?
    private(set) var selected = 0
    private(set) var picking = false

    private let glass = UIVisualEffectView(effect: AttachMenuPanel.glassEffect())
    private static func glassEffect() -> UIGlassEffect {
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = true
        return effect
    }
    /// The tabs' space: the bar less 3 all round, its ends round (28).
    private let tabsHost = UIView()
    private let lens = UIView()
    private let tabsPlain = UIView()
    private let tabsChosen = UIView()
    private let chosenMask = UIView()
    private var plainTabs: [AttachMenuTab] = []
    private var chosenTabs: [AttachMenuTab] = []
    private var accessTabs: [UIView] = []
    private let recognizer = AttachTabRecognizer()
    private var lensDrag: AttachTabLens?

    /// The caption: the chat composer's card without "+" or the chips, in
    /// one row (send beside the text, at its last line) that grows to the
    /// full card's five lines and then scrolls.
    let card = AgentInputCardView(configuration: AgentInputCardConfiguration(
        placeholder: Strings.Composer.inputPlaceholder,
        primaryAction: .send,
        primaryAccessibilityLabel: Strings.AttachMenu.send,
        compact: true,
        compactLines: 5
    ))
    var field: UITextView { card.textView }

    private var placed: (minX: CGFloat, width: CGFloat, bottom: CGFloat, sides: LayoutInsets, pixel: CGFloat, maxHeight: CGFloat)?
    private(set) var layout: AttachMenuPanelLayout?

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(glass)
        tabsHost.clipsToBounds = true
        tabsHost.layer.cornerRadius = 28
        tabsHost.layer.cornerCurve = .continuous
        lens.backgroundColor = UIColor(Palette.attachMenuLens)
        lens.isUserInteractionEnabled = false
        tabsHost.addSubview(lens)
        tabsPlain.isUserInteractionEnabled = false
        tabsChosen.isUserInteractionEnabled = false
        chosenMask.backgroundColor = .black
        tabsChosen.mask = chosenMask
        tabsHost.addSubview(tabsPlain)
        tabsHost.addSubview(tabsChosen)
        glass.contentView.addSubview(tabsHost)
        recognizer.addTarget(self, action: #selector(lensGesture(_:)))
        recognizer.delegate = self
        tabsHost.addGestureRecognizer(recognizer)

        card.delegate = self
        card.textView.accessibilityIdentifier = "attach-caption"
        card.primaryControl.accessibilityIdentifier = "attach-send"
        card.alpha = 0
        card.isHidden = true
        addSubview(card)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// In and out with the sheet's morph: the glass materializes or goes,
    /// what is on it fades (a glass view under a fading alpha draws wrong
    /// and pops at 1). Inside an animation, animates.
    func setShown(_ shown: Bool) {
        glass.effect = shown && !picking ? Self.glassEffect() : nil
        glass.contentView.alpha = shown && !picking ? 1 : 0
        card.alpha = shown && picking ? 1 : 0
    }

    /// The tabs: names, glyphs and accessibility ids.
    func setTabs(_ tabs: [(title: String, glyph: UIImage?, id: String)]) {
        (plainTabs + chosenTabs).forEach { $0.removeFromSuperview() }
        accessTabs.forEach { $0.removeFromSuperview() }
        plainTabs = tabs.map { AttachMenuTab(title: $0.title, glyph: $0.glyph, tint: Palette.attachMenuTab) }
        chosenTabs = tabs.map { AttachMenuTab(title: $0.title, glyph: $0.glyph, tint: Palette.attachMenuTabSelected) }
        plainTabs.forEach(tabsPlain.addSubview)
        chosenTabs.forEach(tabsChosen.addSubview)
        accessTabs = tabs.enumerated().map { index, tab in
            let element = AttachMenuTabElement()
            element.accessibilityLabel = tab.title
            element.accessibilityIdentifier = tab.id
            element.onActivate = { [weak self] in self?.choose(index) }
            element.showsLargeContentViewer = true
            element.largeContentTitle = tab.title
            element.addInteraction(UILargeContentViewerInteraction())
            tabsHost.addSubview(element)
            return element
        }
        relayout(animated: false)
    }

    var caption: String {
        get { card.text }
        set { card.setText(newValue, selection: NSRange(location: (newValue as NSString).length, length: 0), animatesHeight: false) }
    }

    // MARK: Tabs

    func select(_ index: Int, animated: Bool) {
        selected = index
        relayout(animated: animated)
    }

    private func choose(_ index: Int) {
        guard index != selected else { return }
        selected = index
        onTab?(index)
        relayout(animated: true)
    }

    /// The tab's frames in the lens's space (the bar less 3).
    private var tabFrames: [CGRect] {
        (layout?.tabs ?? []).map { $0.frame.offsetBy(dx: -AttachMenuMetrics.barInset, dy: -AttachMenuMetrics.barInset) }
    }

    @objc private func lensGesture(_ recognizer: AttachTabRecognizer) {
        let location = recognizer.location(in: tabsHost)
        switch recognizer.state {
        case .began:
            // With every tab in view, the lens lifts the moment the finger lands.
            lensDrag = AttachTabLens(location: location, frames: tabFrames)
            relayout(animated: true)
        case .changed:
            guard var drag = lensDrag else { return }
            drag.moved(translation: recognizer.translation.x, location: location, frames: tabFrames)
            lensDrag = drag
            relayout(animated: false)
        case .ended, .cancelled:
            guard let drag = lensDrag else { return }
            lensDrag = nil
            if recognizer.state == .ended, drag.item != selected {
                selected = drag.item
                onTab?(drag.item)
            }
            relayout(animated: true)
        default:
            break
        }
    }

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        gestureRecognizer !== recognizer || !picking
    }

    /// Picked or not: the tabs' glass goes and the card comes, or back.
    func setPicking(_ value: Bool, animated: Bool) {
        guard value != picking else { return }
        picking = value
        if !value { field.resignFirstResponder() }
        card.isHidden = false
        glass.isHidden = false
        tabsHost.isUserInteractionEnabled = !value
        let fade = value ? 0.15 : 0.25
        let alpha = {
            self.tabsHost.alpha = value ? 0 : 1
            self.glass.effect = value ? nil : Self.glassEffect()
            self.card.alpha = value ? 1 : 0
        }
        let done = { (_: Bool) in
            guard self.picking == value else { return }
            self.card.isHidden = !value
            self.glass.isHidden = value
        }
        if animated {
            UIView.animate(withDuration: fade, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState], animations: alpha, completion: done)
        } else {
            alpha()
            done(true)
        }
        relayout(animated: animated)
    }

    // MARK: Layout

    /// `bottom` is the sheet's foot, or the keyboard's top while the caption has it.
    func place(minX: CGFloat, width: CGFloat, bottom: CGFloat, sides: LayoutInsets, pixel: CGFloat, maxHeight: CGFloat) {
        placed = (minX, width, bottom, sides, pixel, maxHeight)
        relayout(animated: false)
    }

    /// The tab bar, or the caption's card while picking.
    var glassFrame: CGRect { frame }

    /// The card where the chat's composer would stand: the composer's
    /// inset from the sheet's sides, on the bar's foot or 8 over the
    /// keyboard, as tall as its text asks (it caps and scrolls itself).
    private func cardFrame(_ placed: (minX: CGFloat, width: CGFloat, bottom: CGFloat, sides: LayoutInsets, pixel: CGFloat, maxHeight: CGFloat)) -> CGRect {
        let inset = MobileComposerMetrics.mobile.shellInset
        let width = max(0, placed.width - placed.sides.left - placed.sides.right - 2 * inset)
        let height = card.height(fitting: width)
        let spacing = field.isFirstResponder ? AttachMenuMetrics.captionFocusedBottom : AttachMenuMetrics.barBottom
        return CGRect(x: placed.minX + placed.sides.left + inset, y: placed.bottom - spacing - height, width: width, height: height)
    }

    private func relayout(animated: Bool) {
        guard let placed else { return }
        let layout = AttachMenuPanelLayout(.init(
            minX: placed.minX, width: placed.width, bottom: placed.bottom, sides: placed.sides,
            titles: plainTabs.map(\.titleSize), selected: selected, picking: false, pixel: placed.pixel
        ))
        self.layout = layout
        let caption = cardFrame(placed)
        let own = picking ? caption : layout.tabBar
        let inset = AttachMenuMetrics.barInset
        let lensRest = layout.lens.offsetBy(dx: -inset, dy: -inset)
        let lifted = lensDrag != nil
        let lensFrame = lensDrag.map { $0.lens(selection: layout.lens, width: layout.tabBar.width).offsetBy(dx: -inset, dy: -inset) }
            ?? (lifted ? lensRest.insetBy(dx: -AttachTabLens.lift, dy: -AttachTabLens.lift) : lensRest)
        let apply = {
            // The panel spans the bar or the card; the tabs keep the bar's place.
            self.frame = own
            self.glass.frame = layout.tabBar.offsetBy(dx: -own.minX, dy: -own.minY)
            self.glass.cornerConfiguration = .capsule(maximumRadius: layout.glassRadius)
            self.card.frame = caption.offsetBy(dx: -own.minX, dy: -own.minY)
            self.card.layoutIfNeeded()
            let tabsOrigin = CGPoint(x: inset, y: inset + (self.picking ? -AttachMenuMetrics.tabsRise : 0))
            self.tabsHost.frame = CGRect(origin: tabsOrigin, size: CGSize(width: layout.tabBar.width - 2 * inset, height: layout.tabBar.height - 2 * inset))
            self.tabsPlain.frame = self.tabsHost.bounds
            self.tabsChosen.frame = self.tabsHost.bounds
            self.lens.frame = lensFrame
            self.lens.layer.cornerRadius = lensFrame.height / 2
            self.chosenMask.frame = lensFrame
            self.chosenMask.layer.cornerRadius = lensFrame.height / 2
            for (index, tab) in layout.tabs.enumerated() {
                let frame = tab.frame.offsetBy(dx: -inset, dy: -inset)
                let parts = (icon: tab.icon.offsetBy(dx: -tab.frame.minX, dy: -tab.frame.minY), title: tab.title.offsetBy(dx: -tab.frame.minX, dy: -tab.frame.minY))
                if self.plainTabs.indices.contains(index) { self.plainTabs[index].place(frame, icon: parts.icon, title: parts.title) }
                if self.chosenTabs.indices.contains(index) { self.chosenTabs[index].place(frame, icon: parts.icon, title: parts.title) }
                if self.accessTabs.indices.contains(index) {
                    self.accessTabs[index].frame = frame
                    self.accessTabs[index].accessibilityTraits = index == self.selected ? [.button, .selected] : .button
                }
            }
        }
        guard animated, window != nil else { return apply() }
        let curve = AttachMenuMotion.openCurve
        let animator = UIViewPropertyAnimator(duration: AttachMenuMotion.barDuration, controlPoint1: CGPoint(x: CGFloat(curve.x1), y: CGFloat(curve.y1)), controlPoint2: CGPoint(x: CGFloat(curve.x2), y: CGFloat(curve.y2)), animations: apply)
        animator.isUserInteractionEnabled = true
        animator.startAnimation()
    }

    // For tests: the lens and the chosen tab as laid out.
    var lensFrame: CGRect { lens.convert(lens.bounds, to: self) }
    func tabParts(_ index: Int) -> (frame: CGRect, icon: CGRect, title: CGRect)? {
        guard plainTabs.indices.contains(index) else { return nil }
        let tab = plainTabs[index]
        return (tab.convert(tab.bounds, to: self), tab.iconView.convert(tab.iconView.bounds, to: self), tab.label.convert(tab.label.bounds, to: self))
    }
    var tabsAlpha: CGFloat { tabsHost.alpha }
}

/// A tab's glyph over its name, in one ink.
final class AttachMenuTab: UIView {
    let iconView = UIImageView()
    let label = UILabel()

    init(title: String, glyph: UIImage?, tint: ColorToken) {
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        iconView.image = glyph
        iconView.contentMode = .center
        iconView.tintColor = UIColor(tint)
        label.text = title
        // Telegram's glass tabs: medium 10.
        label.font = .systemFont(ofSize: 10, weight: .medium)
        label.textColor = UIColor(tint)
        label.textAlignment = .center
        addSubview(iconView)
        addSubview(label)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    var titleSize: CGSize { label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 20)) }

    func place(_ frame: CGRect, icon: CGRect, title: CGRect) {
        self.frame = frame
        iconView.frame = icon
        label.frame = title
    }
}

/// A tab as VoiceOver and Large Content Viewer see it.
final class AttachMenuTabElement: UIView {
    var onActivate: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isAccessibilityElement = true
        accessibilityTraits = .button
        isUserInteractionEnabled = true
        backgroundColor = .clear
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func accessibilityActivate() -> Bool {
        onActivate?()
        return true
    }

    // Touches go to the bar's lens recognizer under it.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool { false }
}

/// Telegram's `TabSelectionRecognizer`: begins the moment a finger lands,
/// follows it, and ends when it lifts; its translation is from where it landed.
final class AttachTabRecognizer: UIGestureRecognizer {
    private var start: CGPoint?
    private var current: CGPoint?

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    var translation: CGPoint {
        guard let start, let current else { return .zero }
        return CGPoint(x: current.x - start.x, y: current.y - start.y)
    }

    override func reset() {
        super.reset()
        start = nil
        current = nil
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        if start == nil { start = touches.first?.location(in: view) }
        current = start
        state = .began
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesMoved(touches, with: event)
        current = touches.first?.location(in: view)
        state = .changed
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesEnded(touches, with: event)
        state = .ended
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesCancelled(touches, with: event)
        state = .cancelled
    }
}

extension AttachMenuPanel {
    /// Telegram's tab glyphs (`TabPhoto`, `TabFile`: two filled photos, a
    /// filled page), drawn 26 inside the 30 square.
    static func glyph(_ symbol: String) -> UIImage? {
        let configuration = UIImage.SymbolConfiguration(pointSize: 21, weight: .medium)
        guard let image = UIImage(systemName: symbol, withConfiguration: configuration) else { return nil }
        let box = CGSize(width: 30, height: 30)
        let fit = min(1, 26 / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * fit, height: image.size.height * fit)
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        return UIGraphicsImageRenderer(size: box, format: format).image { _ in
            image.draw(in: CGRect(x: (box.width - size.width) / 2, y: (box.height - size.height) / 2, width: size.width, height: size.height))
        }.withRenderingMode(.alwaysTemplate)
    }
}
extension AttachMenuPanel: AgentInputCardDelegate {
    func agentInputCardDidChangeText(_ card: AgentInputCardView) {
        onCaption?(card.text)
    }

    func agentInputCardDidChangeFocus(_ card: AgentInputCardView) {
        onFocus?(card.textView.isFirstResponder)
        relayout(animated: true)
        onResize?()
    }

    func agentInputCardDidInvalidateHeight(_ card: AgentInputCardView) {
        let before = frame.height
        relayout(animated: false)
        if frame.height != before { onResize?() }
    }

    func agentInputCardDidPressPrimary(_ card: AgentInputCardView) {
        onSend?()
    }
}
#endif
