#if canImport(UIKit)
import HappyLayout
import UIKit

/// Telegram's springs and eases for a lifted message
/// (`makeSpringBounceAnimation`, `animateSpring`).
enum LiftMotion {
    /// Mass 5, stiffness 900, `damping`, run over `duration` however long
    /// the spring takes to settle, as Telegram speeds its springs up.
    static func spring(_ keyPath: String, from: Any, to: Any, duration: TimeInterval = MessageLiftLayout.Metrics.springDuration,
                       damping: CGFloat = MessageLiftLayout.Metrics.springDamping, additive: Bool = false) -> CASpringAnimation {
        typealias M = MessageLiftLayout.Metrics
        let animation = CASpringAnimation(keyPath: keyPath)
        animation.mass = M.springMass
        animation.stiffness = M.springStiffness
        animation.damping = damping
        animation.fromValue = from
        animation.toValue = to
        animation.isAdditive = additive
        animation.duration = animation.settlingDuration
        animation.speed = Float(animation.settlingDuration / duration)
        animation.timingFunction = CAMediaTimingFunction(name: .linear)
        return animation
    }

    static func ease(_ keyPath: String, from: Any, to: Any, duration: TimeInterval, additive: Bool = false) -> CABasicAnimation {
        let animation = CABasicAnimation(keyPath: keyPath)
        animation.fromValue = from
        animation.toValue = to
        animation.isAdditive = additive
        animation.duration = duration
        animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        animation.fillMode = .forwards
        animation.isRemovedOnCompletion = false
        return animation
    }
}

/// Where a lifted message came from and goes back to: its plan, frozen as
/// it was held, and the row that shows it, which hides its own drawing
/// while the copy is up and is looked up again on the way back, since a
/// streaming reply may have moved or redrawn it meanwhile.
@MainActor
struct MessageLiftSource {
    let plan: ChatRowPlan
    let selection: ChatSelectable
    /// The row's view the plan is drawn in now, if it is still on screen.
    var canvas: () -> UIView?
    var setLifted: (Bool) -> Void
    /// What the lifted message's media and links answer to.
    weak var host: UIViewController?
}

/// A held message lifted out of the chat, as Telegram lifts one into its
/// context menu (`ContextControllerExtractedPresentationNode`): the chat
/// blurs and dims behind it, the message stays where it was, or moves
/// just enough to fit, and the actions hang under it. A message taller
/// than the room scrolls inside it. Select starts a selection over the
/// message's words (`MessageTextSelectionView`); a tap off the message
/// puts it back where it now is in the chat.
///
/// Adapted from Telegram-iOS `ContextControllerExtractedPresentationNode`
/// and `ContextControllerImpl` (permission from Steve).
final class MessageLiftOverlay: UIView, UIScrollViewDelegate {
    /// The one shown now, for the UI tests' probe.
    private(set) static weak var shown: MessageLiftOverlay?

    /// Its padding round an agent's words, which lift on a card.
    static let cardPadding: CGFloat = 10
    static let cardCorner: CGFloat = 18

    private let source: MessageLiftSource
    private let backdrop = UIVisualEffectView(effect: nil)
    private let dim = LiftDim()
    /// The message's window: all of it, or what a tall one shows.
    let viewport = UIScrollView()
    private let content = UIView()
    private let card = UIView()
    private let planView = ChatPlanView()
    let selection: MessageTextSelectionView
    let menu: HoldMenuView
    /// The message in its row: what lifts, in the row's coordinates.
    private let lifted: CGRect
    private let layout: MessageLiftLayout
    /// Where the message was on screen when it lifted.
    private let from: CGRect
    private var closing = false
    private var finished = false
    /// A selection is up: the actions step aside, as Telegram's do.
    private var selecting = false

    /// Lifts `source`'s message from its canvas in `window`. Nil when the
    /// row is not on screen.
    @discardableResult
    static func present(_ source: MessageLiftSource, in window: UIWindow) -> MessageLiftOverlay? {
        guard shown == nil, let canvas = source.canvas(), canvas.window === window else { return nil }
        source.host?.view.endEditing(true)
        let overlay = MessageLiftOverlay(source: source, window: window, canvas: canvas)
        window.addSubview(overlay)
        shown = overlay
        source.setLifted(true)
        Haptics.play(.hold)
        overlay.animateIn()
        return overlay
    }

    private init(source: MessageLiftSource, window: UIWindow, canvas: UIView) {
        self.source = source
        let selection = source.selection
        lifted = selection.card ? selection.frame.insetBy(dx: -Self.cardPadding, dy: -Self.cardPadding) : selection.frame
        from = canvas.convert(lifted, to: window)
        let whole = selection.whole
        // The items run once the overlay exists.
        let target = LiftTarget()
        menu = HoldMenuView(items: [[
            MenuItem(title: Strings.Chat.copy, icon: "copy-outline") { target.overlay?.copy(whole) },
            MenuItem(title: Strings.MessageSelection.select, icon: "text-outline") { target.overlay?.selection.selectAll() },
        ]])
        self.selection = MessageTextSelectionView(selectable: selection, size: source.plan.size)
        let insets = window.safeAreaInsets
        layout = MessageLiftLayout(
            screen: window.bounds.size, top: insets.top, bottom: insets.bottom, source: from, menu: menu.layout.size,
            side: MessageLiftLayout.side(of: lifted, in: source.plan.size.width)
        )
        super.init(frame: window.bounds)
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        accessibilityViewIsModal = true
        accessibilityIdentifier = "message-lift"

        backdrop.frame = bounds
        backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        dim.frame = bounds
        dim.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        dim.backgroundColor = UIColor(Palette.holdDim)
        dim.isAccessibilityElement = true
        dim.accessibilityLabel = Strings.closeMenu
        dim.accessibilityTraits = .button
        dim.accessibilityIdentifier = "lift-dismiss"
        dim.activate = { [weak self] in self?.dismiss() }
        dim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tappedAway)))
        addSubview(backdrop)
        addSubview(dim)

        viewport.frame = layout.viewport
        viewport.contentSize = CGSize(width: layout.viewport.width, height: layout.contentHeight)
        viewport.contentOffset = CGPoint(x: 0, y: layout.offset)
        viewport.showsHorizontalScrollIndicator = false
        viewport.alwaysBounceVertical = layout.contentHeight > layout.viewport.height
        viewport.contentInsetAdjustmentBehavior = .never
        viewport.scrollsToTop = false
        viewport.clipsToBounds = true
        viewport.delegate = self
        viewport.isAccessibilityElement = false
        addSubview(viewport)
        content.frame = CGRect(origin: .zero, size: viewport.contentSize)
        viewport.addSubview(content)
        if selection.card {
            card.frame = content.bounds
            card.backgroundColor = UIColor(Palette.liftCard)
            card.layer.cornerRadius = Self.cardCorner
            card.layer.cornerCurve = .continuous
            content.addSubview(card)
        }
        // The message drawn again from the plan it was held with: the same
        // layouts, so its glyphs land where the row drew them.
        planView.drawsStaticContent = true
        planView.cutsTallPlans = true
        planView.drawsTextOffMain = true
        planView.isUserInteractionEnabled = false
        planView.frame = CGRect(origin: CGPoint(x: -lifted.minX, y: -lifted.minY), size: source.plan.size)
        planView.apply(source.plan)
        content.addSubview(planView)
        self.selection.frame = planView.frame
        content.addSubview(self.selection)
        content.isAccessibilityElement = true
        content.accessibilityLabel = source.plan.accessibilityLabel
        content.accessibilityTraits = .staticText
        content.accessibilityIdentifier = "lifted-message"
        content.accessibilityCustomActions = [
            UIAccessibilityCustomAction(name: Strings.Chat.copy) { [weak self] _ in self?.copy(whole); return true },
        ]
        self.selection.onActive = { [weak self] active in self?.selectionChanged(active) }
        self.selection.onCopy = { [weak self] text in self?.copy(text) }
        self.selection.onShare = { [weak self] text in self?.share(text) }
        self.selection.onSelectionRead = { [weak self] text in self?.content.accessibilityValue = text }
        updateBand()

        menu.frame = layout.menu
        menu.onPick = { item in item.run() }
        addSubview(menu)
        target.overlay = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    /// What `next` answers for: the chat, whose media sources the
    /// message's pictures load from.
    override var next: UIResponder? { source.host ?? super.next }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Turned or resized under it: put back at once.
        if let window, bounds.size != window.bounds.size || layout.viewport.maxX > window.bounds.width + 0.5 { dismiss(animated: false) }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) { updateBand() }

    /// Only the part of a tall message on screen has views.
    private func updateBand() {
        planView.band = CGRect(x: 0, y: viewport.contentOffset.y + lifted.minY, width: source.plan.size.width, height: viewport.bounds.height)
            .insetBy(dx: 0, dy: -viewport.bounds.height)
    }

    // MARK: Motion

    /// How far the message's top moved from where it was in the chat.
    private var distance: CGFloat { layout.viewport.minY - (from.minY + layout.offset) }

    /// The menu grows out of the message's foot.
    private var menuFrom: CGPoint {
        CGPoint(x: 0, y: -distance - menu.bounds.height / 2 - MessageLiftLayout.Metrics.spacing)
    }

    private func animateIn() {
        typealias M = MessageLiftLayout.Metrics
        backdrop.effect = UIBlurEffect(style: traitCollection.userInterfaceStyle == .dark ? .dark : .light)
        UIAccessibility.post(notification: .screenChanged, argument: menu)
        guard !UIAccessibility.isReduceMotionEnabled else { return }
        for layer in [backdrop.layer, dim.layer] {
            layer.add(LiftMotion.ease("opacity", from: 0, to: 1, duration: M.backdropDuration).removedOnCompletion(), forKey: "in")
        }
        if distance != 0 {
            viewport.layer.add(LiftMotion.spring("position.y", from: -distance, to: 0, additive: true), forKey: "in")
        }
        menu.layer.add(LiftMotion.ease("opacity", from: 0, to: 1, duration: M.menuFadeDuration).removedOnCompletion(), forKey: "in-fade")
        menu.layer.add(LiftMotion.spring("transform.scale", from: 0.01, to: 1), forKey: "in-scale")
        menu.layer.add(LiftMotion.spring("position", from: NSValue(cgPoint: menuFrom), to: NSValue(cgPoint: .zero), additive: true), forKey: "in-position")
    }

    /// Back into the chat over 0.2 s, to where the row is now; `then` runs
    /// once it is gone and the row draws itself again.
    func dismiss(animated: Bool = true, then: (() -> Void)? = nil) {
        guard !closing else {
            if !animated { finish(then) }
            return
        }
        closing = true
        isUserInteractionEnabled = false
        selection.clear(notify: false)
        guard animated, !UIAccessibility.isReduceMotionEnabled else { return finish(then) }
        typealias M = MessageLiftLayout.Metrics
        func now<T>(_ layer: CALayer, _ keyPath: String, _ model: T) -> T {
            layer.presentation()?.value(forKeyPath: keyPath) as? T ?? model
        }
        // From wherever the way in has got to.
        let viewportY: CGFloat = now(viewport.layer, "position.y", viewport.layer.position.y) - viewport.layer.position.y
        let menuScale: CGFloat = now(menu.layer, "transform.scale", 1)
        let menuAt: CGPoint = now(menu.layer, "position", menu.layer.position)
        let menuOffset = CGPoint(x: menuAt.x - menu.layer.position.x, y: menuAt.y - menu.layer.position.y)
        viewport.layer.removeAllAnimations()
        menu.layer.removeAllAnimations()
        // Where the row is now: it may have moved while the copy was up.
        let target: CGRect? = source.canvas().flatMap { canvas in
            canvas.window == nil ? nil : canvas.convert(lifted, to: self)
        }
        let back = target.map { viewport.frame.minY - ($0.minY + viewport.contentOffset.y) } ?? 0
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in self?.finish(then) }
        for layer in [backdrop.layer, dim.layer, menu.layer] {
            layer.add(LiftMotion.ease("opacity", from: now(layer, "opacity", layer.opacity), to: 0, duration: M.dismissDuration), forKey: "out-fade")
        }
        if target != nil {
            viewport.layer.add(LiftMotion.ease("position.y", from: viewportY, to: -back, duration: M.dismissDuration, additive: true), forKey: "out")
        } else {
            viewport.layer.add(LiftMotion.ease("opacity", from: 1, to: 0, duration: M.dismissDuration), forKey: "out-fade")
        }
        menu.layer.add(LiftMotion.ease("transform.scale", from: menuScale, to: 0.01, duration: M.dismissDuration), forKey: "out-scale")
        let menuTo = CGPoint(x: 0, y: -back - menu.bounds.height / 2 - M.spacing)
        menu.layer.add(LiftMotion.ease("position", from: NSValue(cgPoint: menuOffset), to: NSValue(cgPoint: menuTo), duration: M.dismissDuration, additive: true), forKey: "out-position")
        CATransaction.commit()
    }

    /// The row draws itself again in the same commit the copy goes, so
    /// there is no frame with neither.
    private func finish(_ then: (() -> Void)?) {
        guard !finished else { return }
        finished = true
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        source.setLifted(false)
        removeFromSuperview()
        CATransaction.commit()
        if Self.shown === self { Self.shown = nil }
        then?()
    }

    /// `host` is going: what it lifted goes at once.
    static func putBack(from host: UIViewController) {
        guard let shown, shown.source.host === host else { return }
        shown.dismiss(animated: false)
    }

    @objc private func tappedAway() { dismiss() }

    override func accessibilityPerformEscape() -> Bool {
        dismiss()
        return true
    }

    // MARK: Actions

    fileprivate func copy(_ text: String) {
        UIPasteboard.general.string = text
        dismiss()
    }

    private func share(_ text: String) {
        let host = source.host
        dismiss {
            guard let host else { return }
            let sheet = UIActivityViewController(activityItems: [text], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = host.view
            sheet.popoverPresentationController?.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.maxY - 1, width: 1, height: 1)
            var top: UIViewController = host
            while let presented = top.presentedViewController { top = presented }
            top.present(sheet, animated: true)
        }
    }

    /// Telegram's actions step aside while words are selected, and come
    /// back once the selection goes.
    private func selectionChanged(_ active: Bool) {
        guard active != selecting, !closing else { return }
        selecting = active
        menu.isUserInteractionEnabled = !active
        let to: Float = active ? 0 : 1
        menu.layer.add(LiftMotion.ease("opacity", from: menu.layer.presentation()?.opacity ?? menu.layer.opacity, to: to, duration: 0.2).removedOnCompletion(), forKey: "selecting")
        menu.layer.opacity = to
        menu.accessibilityElementsHidden = active
    }

    #if DEBUG || HAPPY_FIXTURES
    /// What the UI tests read of it.
    var probe: [String: Any] {
        var value: [String: Any] = [:]
        value["viewport"] = [viewport.frame.minX, viewport.frame.minY, viewport.frame.width, viewport.frame.height].map { Double($0) }
        value["menu"] = menu.layer.opacity > 0 ? [menu.frame.minX, menu.frame.minY, menu.frame.width, menu.frame.height].map { Double($0) } : []
        value["offset"] = Double(viewport.contentOffset.y)
        value["contentHeight"] = Double(viewport.contentSize.height)
        value["selected"] = selection.selectedText ?? NSNull()
        value["range"] = selection.selected.map { [$0.lowerBound, $0.upperBound] } ?? []
        value["length"] = selection.run.length
        value["closing"] = closing
        if selection.selected != nil {
            value["start"] = rect(selection.startKnob)
            value["end"] = rect(selection.endKnob)
        }
        return value
    }

    private func rect(_ view: UIView) -> [Double] {
        let frame = view.convert(view.bounds, to: self)
        return [frame.minX, frame.minY, frame.width, frame.height].map { Double($0) }
    }
    #endif
}

extension CABasicAnimation {
    /// Gone once it has run, leaving the model value.
    func removedOnCompletion() -> CABasicAnimation {
        isRemovedOnCompletion = true
        fillMode = .removed
        return self
    }
}

/// What the menu's items act on, set once the overlay exists.
@MainActor
private final class LiftTarget {
    weak var overlay: MessageLiftOverlay?
}

/// The dimmed chat behind the message: a tap, or VoiceOver's, puts it back.
private final class LiftDim: UIView {
    var activate: (() -> Void)?

    override func accessibilityActivate() -> Bool {
        activate?()
        return true
    }
}
#endif
