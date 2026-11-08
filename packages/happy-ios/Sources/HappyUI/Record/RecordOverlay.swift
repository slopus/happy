#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import Lottie
import UIKit

/// Where the clock and "Slide to cancel" show while recording: a part of
/// the host's screen, in the window's space, its corners, and who draws it.
struct RecordBar: Equatable {
    enum Ground: Equatable {
        /// The host's own glass is the bar: home's toolbar morphs its
        /// buttons into it, and only what is in it is drawn here.
        case host
        /// Drawn here in the button's fill, stretching out of the button
        /// as it comes and back into it as it goes.
        case grown
    }

    var frame: CGRect
    var cornerRadius: CGFloat
    var ground: Ground = .grown
}

/// What a cancel's bin stands in for while it plays, as Telegram's stands
/// in for the attach button: hidden till the bin shuts, then growing back
/// as the bin shrinks away.
struct RecordBinSpot {
    /// A view of the host's: the bin travels to its middle, and it is
    /// hidden and grown back here.
    var icon: UIView?
    /// Or an icon only the host can reach (search's magnifier, drawn by
    /// the system): the bin plays where the dot was, under which it sits,
    /// and this hides it (true) and shows it again (false).
    var hide: ((Bool) -> Void)?
}

/// Telegram's recording screen over everything, the keyboard included, in
/// a window of its own (`TGModernConversationInputMicWindow`): the blue
/// circle under the finger, the waves the voice swells, the lock pill above
/// and the bar with the dot, the clock and "Slide to cancel".
///
/// Adapted from Telegram-iOS `TGModernConversationInputMicButton.m`
/// (`animateIn`, `animateLock`, `animateOut`, `displayLinkUpdate`) and
/// `ChatTextInputPanelNode`'s recording state. Every frame comes from
/// `RecordOverlayLayout`; the circles, the drag and the appearing spring
/// are stepped once a frame (`RecordMotion`), so nothing animates over
/// what the finger is doing.
@MainActor
final class RecordOverlay {
    var onSend: (() -> Void)?
    var onStop: (() -> Void)?
    var onCancel: (() -> Void)?

    private let window: RecordOverlayWindow
    private let root = UIView()
    private let bar = UIView()
    /// What the bar holds, faded in over the host's glass as it morphs.
    private let barContent = UIView()
    private let dot = UIView()
    private let clock = UILabel()
    private let cancelLine = UIView()
    private let cancelArrow = IconView(.ionicons("chevron-back"), size: 14, tint: Palette.textSecondary)
    private let cancelLabel = StyledLabel(style: TextStyles.recordCancel, color: Palette.textSecondary, lines: 1)
    private let cancelButton = UIButton(type: .system)
    /// The waves round the circle (`RecordBlob`).
    private let waves = UIView()
    private let outerWave = CAShapeLayer()
    private let middleWave = CAShapeLayer()
    private var outerBlob = RecordBlob(seed: 1)
    private var middleBlob = RecordBlob(seed: 2)
    private let inner = UIControl()
    private let micGlyph = IconView(.ionicons("mic"), size: 30, tint: Palette.Record.glyph)
    private let sendGlyph = IconView(.ionicons("arrow-up"), size: 30, tint: Palette.Record.glyph)
    private let lockWrapper = UIView()
    private let lockPanel = UIControl()
    private let lockGlass = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
    private let lockGlyph = RecordLockView()
    /// A cancel's bin (Telegram's `BinRed`), while it plays, and the icon
    /// it stands in for, hidden till it shuts.
    private var bin: LottieAnimationView?
    private var binSpot: RecordBinSpot?

    private var button: CGRect = .zero
    private var barShape = RecordBar(frame: .zero, cornerRadius: 0)
    /// The bar's growth is stepped from this time on; nil once it has
    /// grown (or the host draws the bar).
    private var growing: CFTimeInterval?
    private var gesture = RecordGesture()
    private var level: CGFloat = 0
    private var motion = RecordMotion()
    private var started: CFTimeInterval = 0
    private var lastTick: CFTimeInterval = 0
    private var displayLink: CADisplayLink?
    private var lockStart: (time: CFTimeInterval, from: CGFloat)?
    private(set) var isLocked = false
    private var isDismissing = false
    private var shownClock = ""
    private var measured: (clock: CGSize, arrow: CGSize, label: CGSize, cancel: CGSize) = (.zero, .zero, .zero, .zero)

    init(scene: UIWindowScene) {
        window = RecordOverlayWindow(windowScene: scene)
        window.windowLevel = UIWindow.Level(rawValue: 1_000_000_000)
        window.backgroundColor = .clear
        let controller = RecordOverlayController()
        controller.view = root
        window.rootViewController = controller
        root.backgroundColor = .clear
        build()
    }

    private func build() {
        bar.clipsToBounds = true
        bar.layer.cornerCurve = .continuous
        bar.addSubview(barContent)
        dot.backgroundColor = UIColor(Palette.Record.dot)
        dot.layer.cornerRadius = RecordOverlayLayout.Metrics.dotSize / 2
        barContent.addSubview(dot)
        clock.font = .monospacedDigitSystemFont(ofSize: 15, weight: .regular)
        clock.textColor = UIColor(Palette.text)
        barContent.addSubview(clock)
        cancelLabel.string = Strings.Record.slideToCancel
        cancelLine.addSubview(cancelArrow)
        cancelLine.addSubview(cancelLabel)
        cancelLine.isUserInteractionEnabled = false
        barContent.addSubview(cancelLine)
        cancelButton.setTitle(Strings.Record.cancel, for: .normal)
        cancelButton.titleLabel?.font = TextStyles.recordCancelButton.font
        cancelButton.tintColor = UIColor(Palette.Record.circle)
        cancelButton.accessibilityIdentifier = "record-cancel"
        cancelButton.alpha = 0
        cancelButton.addAction(UIAction { [weak self] _ in self?.onCancel?() }, for: .touchUpInside)
        barContent.addSubview(cancelButton)
        root.addSubview(bar)

        lockGlass.clipsToBounds = true
        lockGlass.isUserInteractionEnabled = false
        lockPanel.addSubview(lockGlass)
        lockGlyph.isUserInteractionEnabled = false
        lockPanel.addSubview(lockGlyph)
        lockPanel.accessibilityLabel = Strings.Record.lock
        lockPanel.accessibilityIdentifier = "record-stop"
        lockPanel.isAccessibilityElement = true
        lockPanel.accessibilityTraits = .button
        lockPanel.addAction(UIAction { [weak self] _ in
            guard let self, self.isLocked else { return }
            self.onStop?()
        }, for: .touchUpInside)
        lockWrapper.addSubview(lockPanel)
        root.addSubview(lockWrapper)

        let ring = UIColor(Palette.Record.circle)
        waves.isUserInteractionEnabled = false
        for wave in [outerWave, middleWave] {
            wave.actions = ["path": NSNull(), "fillColor": NSNull()]
            waves.layer.addSublayer(wave)
        }
        // Under the lock pill: the waves never cover it.
        root.insertSubview(waves, belowSubview: lockWrapper)
        inner.backgroundColor = ring
        inner.accessibilityLabel = Strings.Record.send
        inner.accessibilityIdentifier = "record-send"
        inner.isAccessibilityElement = true
        inner.accessibilityTraits = .button
        inner.addAction(UIAction { [weak self] _ in
            guard let self, self.isLocked else { return }
            self.onSend?()
        }, for: .touchUpInside)
        sendGlyph.alpha = 0
        inner.addSubview(micGlyph)
        inner.addSubview(sendGlyph)
        root.addSubview(inner)

        window.interactive = { [weak self] in
            guard let self, self.isLocked, !self.isDismissing else { return [] }
            return [self.inner, self.lockPanel, self.cancelButton]
        }
    }

    // MARK: Presenting

    /// Comes in over `button` (in the window's space), the clock in `bar`:
    /// the circles spring up from a fifth, the pill rises 100 into place,
    /// the bar stretches out of the button (or the host's glass morphs
    /// into it) and its line slides in from the right edge.
    func present(button: CGRect, bar barShape: RecordBar, mode: RecordMode) {
        clearBin()
        self.button = button
        self.barShape = barShape
        started = CACurrentMediaTime()
        lastTick = started
        bar.layer.removeAllAnimations()
        barContent.layer.removeAllAnimations()
        switch barShape.ground {
        case .host:
            growing = nil
            bar.backgroundColor = .clear
        case .grown:
            growing = started
            bar.backgroundColor = UIColor(Palette.surfaceHighest)
        }
        motion = RecordMotion()
        outerBlob = RecordBlob(seed: .random(in: 0...UInt64.max))
        middleBlob = RecordBlob(seed: .random(in: 0...UInt64.max))
        level = 0
        isLocked = false
        isDismissing = false
        lockStart = nil
        shownClock = ""
        measure()
        window.isHidden = false
        root.frame = window.bounds
        UIView.performWithoutAnimation { apply(at: started) }

        // The bar's pieces, as `ChatTextInputPanelNode` brings them: the
        // bar under them, the dot popping in and then blinking, the clock
        // fading in and the line springing in from the right.
        // Over the host's glass, what the bar holds waits for the morph to
        // be well under way.
        bar.alpha = 1
        barContent.alpha = 0
        dot.isHidden = false
        clock.transform = .identity
        let contentDelay = barShape.ground == .host ? 0.12 : 0
        UIView.animate(withDuration: 0.15, delay: contentDelay, options: [.curveEaseOut, .allowUserInteraction]) { self.barContent.alpha = 1 }
        dot.alpha = 0
        dot.transform = CGAffineTransform(scaleX: 0.3, y: 0.3)
        UIView.animate(withDuration: 0.15, delay: 0, options: [.allowUserInteraction]) {
            self.dot.alpha = 1
            self.dot.transform = .identity
        } completion: { [weak self] _ in
            self?.blink()
        }
        clock.alpha = 0
        UIView.animate(withDuration: 0.5, delay: 0, options: [.curveEaseOut, .allowUserInteraction]) { self.clock.alpha = 1 }
        let from = window.bounds.width + cancelLine.bounds.width - cancelLine.center.x
        let slide = CASpringAnimation(keyPath: "position.x")
        slide.fromValue = from
        slide.toValue = 0
        slide.isAdditive = true
        slide.damping = 22
        slide.stiffness = 220
        slide.mass = 1
        slide.duration = slide.settlingDuration
        cancelLine.layer.add(slide, forKey: "slide-in")
        juggle()
        cancelButton.alpha = 0
        cancelLine.alpha = 1
        micGlyph.alpha = 1
        micGlyph.transform = .identity
        sendGlyph.alpha = 0
        startDisplayLink()
    }

    func update(_ gesture: RecordGesture) {
        self.gesture = gesture
    }

    func setLevel(_ level: CGFloat) {
        self.level = level
        outerBlob.hear(level)
        middleBlob.hear(level)
    }

    /// Hands-free (`animateLock`): the lock shuts and its body turns into
    /// stop (Telegram's `Lock`, played to its end over the pill's 0.2 s),
    /// the pill becomes a circle round it, the glyph on the circle turns
    /// to send and "Slide to cancel" gives way to Cancel. The circle, let
    /// go of, settles back down onto the button.
    func lock() {
        guard !isLocked, !isDismissing else { return }
        isLocked = true
        lockStart = (CACurrentMediaTime(), gesture.lockness)
        var settled = gesture
        _ = settled.move(.zero)
        gesture = settled

        let keyboardCurve = UIView.AnimationOptions(rawValue: 7 << 16)
        sendGlyph.transform = CGAffineTransform(scaleX: 0.3, y: 0.3)
        UIView.animate(withDuration: 0.3, delay: 0, options: [keyboardCurve, .allowUserInteraction]) {
            self.sendGlyph.transform = .identity
            self.micGlyph.transform = CGAffineTransform(scaleX: 0.001, y: 0.001)
        }
        UIView.animate(withDuration: 0.2, delay: 0, options: [.allowUserInteraction]) {
            self.sendGlyph.alpha = 1
            self.micGlyph.alpha = 0
        }
        lockPanel.accessibilityLabel = Strings.Record.stop

        // `updateIsDisplayingCancel`: the line rises and shrinks away as
        // Cancel comes up from under it.
        cancelLine.layer.removeAnimation(forKey: "juggle")
        cancelButton.transform = CGAffineTransform(translationX: 0, y: 22).scaledBy(x: 0.25, y: 0.25)
        UIView.animate(withDuration: 0.25, delay: 0, options: [.allowUserInteraction]) {
            self.cancelLine.transform = CGAffineTransform(translationX: 0, y: -22).scaledBy(x: 0.25, y: 0.25)
            self.cancelLine.alpha = 0
            self.cancelButton.transform = .identity
            self.cancelButton.alpha = 1
        }
    }

    /// Goes (`animateOut`): the circles shrink back into the button in
    /// 0.18 s and the pill drops away. Sent or stopped, the bar's content
    /// fades and a bar drawn here shrinks back into the button.
    ///
    /// Cancelled, it goes as Telegram's does (`ChatTextInputPanelNode`,
    /// `recordingToAttachButton`): "Slide to cancel" fades, the clock
    /// shrinks to half as it fades, a bar drawn here fades where it is,
    /// and the dot becomes Telegram's bin, which travels to `bin` (the
    /// icon it stands in for, hidden meanwhile), jumps in and shuts, then
    /// shrinks away as the icon grows back.
    func dismiss(cancelled: Bool, bin spot: (() -> RecordBinSpot?)? = nil, completion: (() -> Void)? = nil) {
        guard !isDismissing else { return }
        isDismissing = true
        stopDisplayLink()
        typealias M = RecordMotion.Metrics
        let small = CGAffineTransform(scaleX: M.appearScale, y: M.appearScale)
        let drop = CGAffineTransform(translationX: 0, y: M.lockRise).scaledBy(x: 0.2, y: 0.2)
        let grown = barShape.ground == .grown
        // Gone once the last of it is: the circles, a bar drawn here and a
        // cancel's bin (the host's glass morphs back on its own). Nothing
        // waits on a delay: a delayed animation's clock starts when it is
        // made, so a busy main thread would put it on screen already over.
        var parts = 1 + (grown ? 1 : 0) + (cancelled ? 1 : 0)
        let done: (Bool) -> Void = { [weak self] _ in
            parts -= 1
            guard parts == 0, let self, self.isDismissing else { return }
            self.dot.layer.removeAllAnimations()
            self.cancelLine.layer.removeAllAnimations()
            self.cancelLine.transform = .identity
            self.clock.transform = .identity
            self.window.isHidden = true
            completion?()
        }
        UIView.animate(withDuration: M.disappearDuration, delay: 0, options: [.beginFromCurrentState]) {
            self.inner.transform = small
            self.waves.transform = small
            self.inner.alpha = 0
            self.waves.alpha = 0
            self.lockWrapper.transform = drop
            self.lockWrapper.alpha = 0
        } completion: { done($0) }
        guard cancelled else {
            UIView.animate(withDuration: 0.1, delay: 0, options: [.beginFromCurrentState]) {
                self.barContent.alpha = 0
            }
            guard grown else { return }
            let back = layout(lockness: isLocked ? 1 : gesture.lockness, growth: 0)
            UIView.animate(withDuration: M.barShrinkDuration, delay: 0, usingSpringWithDamping: M.barDamping, initialSpringVelocity: 0, options: [.beginFromCurrentState]) {
                self.bar.frame = back.bar
                self.barContent.frame = back.barContent
            } completion: { done($0) }
            return
        }
        cancelLine.layer.removeAllAnimations()
        UIView.animate(withDuration: M.cancelFade, delay: 0, options: [.beginFromCurrentState]) {
            self.cancelLine.alpha = 0
            self.cancelButton.alpha = 0
            if grown { self.bar.backgroundColor = self.bar.backgroundColor?.withAlphaComponent(0) }
        } completion: { grown ? done($0) : () }
        UIView.animate(withDuration: M.binTravel, delay: 0, usingSpringWithDamping: M.binDamping, initialSpringVelocity: 0, options: [.beginFromCurrentState]) {
            self.clock.transform = CGAffineTransform(scaleX: M.cancelClockScale, y: M.cancelClockScale)
            self.clock.alpha = 0
        }
        throwDot(to: spot) { done(true) }
    }

    /// The dot, become the bin where it is: it travels to the spot's icon,
    /// if there is one on screen, plays once and shrinks away as the icon
    /// grows back. The spot is asked for a turn later, once the host has
    /// laid itself out again (home's toolbar is morphing back to search).
    private func throwDot(to spot: (() -> RecordBinSpot?)?, completion: @escaping () -> Void) {
        dot.layer.removeAllAnimations()
        let start = root.convert(dot.center, from: dot.superview)
        guard let animation = Self.binAnimation else {
            UIView.animate(withDuration: 0.15, delay: 0, options: [.beginFromCurrentState]) {
                self.dot.transform = CGAffineTransform(scaleX: 0.3, y: 0.3)
                self.dot.alpha = 0
            } completion: { _ in completion() }
            return
        }
        let bin = LottieAnimationView(animation: animation)
        bin.contentMode = .scaleAspectFit
        bin.isUserInteractionEnabled = false
        bin.setValueProvider(ColorValueProvider(UIColor(Palette.Record.bin).resolvedColor(with: root.traitCollection).lottieColorValue), keypath: AnimationKeypath(keypath: "**.Color"))
        bin.frame = RecordOverlayLayout.bin(around: start)
        root.addSubview(bin)
        self.bin = bin
        dot.isHidden = true
        DispatchQueue.main.async { [weak self, weak bin] in
            guard let self, let bin, self.bin === bin, let spot = spot?() else { return }
            self.binSpot = spot
            spot.hide?(true)
            guard let icon = spot.icon, icon.window != nil else { return }
            icon.isHidden = true
            let target = self.root.convert(CGPoint(x: icon.bounds.midX, y: icon.bounds.midY), from: icon)
            typealias M = RecordMotion.Metrics
            UIView.animate(withDuration: M.binTravel, delay: 0, usingSpringWithDamping: M.binDamping, initialSpringVelocity: 0, options: [.beginFromCurrentState]) {
                bin.center = target
            }
        }
        bin.play { [weak self, weak bin] _ in
            guard let self, let bin, self.bin === bin else { return completion() }
            typealias M = RecordMotion.Metrics
            let gone = CGAffineTransform(scaleX: M.binOutScale, y: M.binOutScale)
            let icon = self.binSpot?.icon
            self.binSpot?.hide?(false)
            self.binSpot?.hide = nil
            icon?.isHidden = false
            icon?.alpha = 0
            icon?.transform = gone
            UIView.animate(withDuration: M.binOut, delay: 0, options: [.curveEaseInOut]) {
                bin.alpha = 0
                bin.transform = gone
                icon?.alpha = 1
                icon?.transform = .identity
            } completion: { _ in
                guard self.bin === bin else { return }
                self.clearBin()
                completion()
            }
        }
    }

    /// A bin still playing goes at once, and its icon comes back.
    private func clearBin() {
        bin?.stop()
        bin?.removeFromSuperview()
        bin = nil
        binSpot?.hide?(false)
        if let icon = binSpot?.icon {
            icon.layer.removeAllAnimations()
            icon.isHidden = false
            icon.alpha = 1
            icon.transform = .identity
        }
        binSpot = nil
    }

    /// Telegram's `BinRed`, read once.
    private static let binAnimation: LottieAnimation? = {
        guard let url = Bundle.module.url(forResource: "record-bin", withExtension: "json")
            ?? Bundle.module.url(forResource: "record-bin", withExtension: "json", subdirectory: "Animations"),
            let data = try? Data(contentsOf: url)
        else { return nil }
        return try? LottieAnimation.from(data: data)
    }()

    // MARK: Frames

    private func measure() {
        clock.text = RecordClock.widest
        let clockSize = clock.sizeThatFits(CGSize(width: 200, height: 100))
        cancelLabel.string = Strings.Record.slideToCancel
        let label = cancelLabel.sizeThatFits(CGSize(width: 240, height: 100))
        let cancel = cancelButton.sizeThatFits(CGSize(width: 240, height: 100))
        measured = (clockSize, CGSize(width: 14, height: 14), label, cancel)
        clock.text = RecordClock.text(0)
    }

    private func layout(lockness: CGFloat, growth: CGFloat = 1) -> RecordOverlayLayout {
        RecordOverlayLayout(.init(
            button: button,
            bar: barShape.frame,
            clock: measured.clock,
            arrow: measured.arrow,
            label: measured.label,
            cancel: measured.cancel,
            cancelTranslation: isLocked ? 0 : gesture.cancelTranslation,
            lockness: lockness,
            growth: growth
        ))
    }

    /// One frame: the level and the drag followed, the spring's place,
    /// the clock, and every frame and transform from them.
    private func apply(at now: CFTimeInterval) {
        let frames = CGFloat(max(0, now - lastTick) * 60)
        lastTick = now
        motion.step(level: level, lift: isLocked ? 0 : gesture.translation.y, slide: isLocked ? 0 : gesture.translation.x, frames: frames)
        let elapsed = now - started
        let lockness = lockStart.map { RecordMotion.lockness(from: $0.from, at: now - $0.time) } ?? gesture.lockness
        var growth: CGFloat = 1
        if let growing {
            growth = RecordMotion.barGrowth(at: now - growing)
            if growth >= 1 { self.growing = nil }
        }
        let layout = layout(lockness: lockness, growth: growth)

        bar.frame = layout.bar
        bar.layer.cornerRadius = barShape.cornerRadius
        barContent.frame = layout.barContent
        let origin = barShape.frame.origin
        func local(_ rect: CGRect) -> CGRect { rect.offsetBy(dx: -origin.x, dy: -origin.y) }
        place(dot, local(layout.dot))
        clock.frame = local(layout.clock)
        let line = local(layout.cancelLine)
        place(cancelLine, line)
        cancelArrow.frame = layout.cancelArrow.offsetBy(dx: -layout.cancelLine.minX, dy: -layout.cancelLine.minY)
        cancelLabel.frame = layout.cancelLabel.offsetBy(dx: -layout.cancelLine.minX, dy: -layout.cancelLine.minY)
        if !isLocked { cancelLine.alpha = layout.cancelLineAlpha }
        place(cancelButton, local(layout.cancelButton))
        let text = RecordClock.text(elapsed)
        if text != shownClock {
            shownClock = text
            clock.text = text
        }

        let appear = RecordMotion.appear(at: elapsed)
        let alpha = RecordMotion.appearAlpha(at: elapsed)
        let start = RecordMotion.Metrics.appearScale
        let lift = CGAffineTransform(translationX: 0, y: motion.lift)

        // The waves are the circle's (Telegram's decoration takes the
        // circle's transform): they shrink and slide with it as the finger
        // drags it, and rise with it.
        let slideScale = isLocked ? 1 : gesture.scale
        place(waves, layout.outer)
        let grown = (start + (1 - start) * appear) * slideScale
        waves.transform = lift.scaledBy(x: grown, y: grown).translatedBy(x: motion.slide, y: 0)
        waves.alpha = alpha
        outerBlob.advance(by: frames / 60)
        middleBlob.advance(by: frames / 60)
        let scales = RecordBlob.scales(level: RecordBlob.swell(motion.level), presence: RecordBlob.presence(at: elapsed))
        let middle = CGPoint(x: layout.outer.width / 2, y: layout.outer.height / 2)
        outerWave.path = Self.path(outerBlob.outline(scale: scales.outer, center: middle))
        middleWave.path = Self.path(middleBlob.outline(scale: scales.middle, center: middle))
        let ring = UIColor(Palette.Record.circle).resolvedColor(with: root.traitCollection)
        outerWave.fillColor = ring.withAlphaComponent(Palette.Record.outerWaveAlpha).cgColor
        middleWave.fillColor = ring.withAlphaComponent(Palette.Record.middleWaveAlpha).cgColor

        place(inner, layout.inner)
        inner.layer.cornerRadius = layout.inner.width / 2
        let innerScale = (start + (1 - start) * appear) * slideScale
        inner.transform = lift.scaledBy(x: innerScale, y: innerScale).translatedBy(x: motion.slide, y: 0)
        inner.alpha = alpha
        for glyph in [micGlyph, sendGlyph] {
            glyph.bounds = CGRect(origin: .zero, size: layout.inner.size)
            glyph.center = CGPoint(x: layout.inner.width / 2, y: layout.inner.height / 2)
        }

        place(lockWrapper, layout.lockWrapper)
        lockWrapper.transform = CGAffineTransform(translationX: 0, y: RecordMotion.Metrics.lockRise * (1 - appear)).concatenating(lift)
        lockWrapper.alpha = min(1, alpha)
        lockPanel.frame = layout.lockPanel
        lockGlass.frame = lockPanel.bounds
        lockGlass.layer.cornerRadius = lockPanel.bounds.width / 2
        lockGlyph.frame = layout.lockGlyph
        lockGlyph.lockness = lockness
    }

    private static func path(_ curves: [RecordBlob.Curve]) -> CGPath {
        let path = CGMutablePath()
        guard let last = curves.last else { return path }
        path.move(to: last.to)
        for curve in curves {
            path.addCurve(to: curve.to, control1: curve.control1, control2: curve.control2)
        }
        path.closeSubpath()
        return path
    }

    /// Bounds and centre, so a transform on it stays about its middle.
    private func place(_ view: UIView, _ frame: CGRect) {
        view.bounds = CGRect(origin: .zero, size: frame.size)
        view.center = CGPoint(x: frame.midX, y: frame.midY)
    }

    // MARK: Loops

    /// Telegram's dot: on, then fading, back and forth twice a second.
    private func blink() {
        guard !isDismissing else { return }
        let animation = CAKeyframeAnimation(keyPath: "opacity")
        animation.values = [1, 1, 0]
        animation.keyTimes = [0, 0.5, 1]
        animation.duration = 0.5
        animation.autoreverses = true
        animation.repeatCount = .infinity
        dot.layer.add(animation, forKey: "blink")
    }

    /// "Slide to cancel" nudging left and back while the finger rests.
    private func juggle() {
        let animation = CABasicAnimation(keyPath: "transform")
        animation.toValue = CATransform3DMakeTranslation(6, 0, 0)
        animation.duration = 1
        animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        animation.autoreverses = true
        animation.repeatCount = .infinity
        cancelLine.layer.add(animation, forKey: "juggle")
    }

    private func startDisplayLink() {
        stopDisplayLink()
        let link = CADisplayLink(target: RecordDisplayTarget(self), selector: #selector(RecordDisplayTarget.tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    private func stopDisplayLink() {
        displayLink?.invalidate()
        displayLink = nil
    }

    fileprivate func tick() {
        let now = CACurrentMediaTime()
        // The finger leaving "Slide to cancel" behind stops its nudge.
        if gesture.cancelTranslation > RecordOverlayLayout.Metrics.cancelThreshold {
            cancelLine.layer.removeAnimation(forKey: "juggle")
        } else if !isLocked, cancelLine.layer.animation(forKey: "juggle") == nil {
            juggle()
        }
        UIView.performWithoutAnimation { apply(at: now) }
    }
}

/// The display link holds its target strongly; this keeps it from holding
/// the overlay.
@MainActor
private final class RecordDisplayTarget: NSObject {
    weak var overlay: RecordOverlay?
    init(_ overlay: RecordOverlay) { self.overlay = overlay }
    @objc func tick() { overlay?.tick() }
}

private final class RecordOverlayController: UIViewController {
    override var preferredStatusBarStyle: UIStatusBarStyle { .default }
    override var prefersStatusBarHidden: Bool { false }
}

/// Takes only its controls' touches once the recording is locked, and
/// every other touch then too, so a tap elsewhere can't leave the screen
/// the recording is for; while the finger holds the button, nothing.
final class RecordOverlayWindow: UIWindow {
    var interactive: () -> [UIView] = { [] }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let controls = interactive()
        guard !controls.isEmpty else { return nil }
        for control in controls where control.alpha > 0.01 && !control.isHidden {
            let local = control.convert(point, from: self)
            if control.bounds.insetBy(dx: -8, dy: -8).contains(local) { return control }
        }
        return rootViewController?.view
    }
}

/// Telegram's `LockView`: its `LockWait` bobbing while the lock is open
/// and untouched, and its `Lock` following the finger up, the shackle
/// closing and the chevron flying up and away as the body turns into
/// stop. Both in the lock colour (`panelControlColor`).
final class RecordLockView: UIView {
    var lockness: CGFloat = 0 {
        didSet { if lockness != oldValue { update() } }
    }

    // Drawn on the main thread, as Telegram's are: `Lock` is scrubbed
    // every frame the finger moves.
    private let idle = LottieAnimationView(animation: RecordLockView.idleAnimation, configuration: LottieConfiguration(renderingEngine: .mainThread))
    private let locking = LottieAnimationView(animation: RecordLockView.lockAnimation, configuration: LottieConfiguration(renderingEngine: .mainThread))

    override init(frame: CGRect) {
        super.init(frame: frame)
        for view in [idle, locking] {
            view.contentMode = .scaleAspectFit
            view.backgroundColor = .clear
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
        idle.loopMode = .autoReverse
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.paint() }
        paint()
        update()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        idle.frame = bounds
        locking.frame = bounds
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        update()
    }

    /// `updateLockness`: the idle loop only while the lock is untouched.
    private func update() {
        let still = lockness <= 0
        idle.isHidden = !still
        locking.isHidden = still
        if still, window != nil {
            if !idle.isAnimationPlaying { idle.play() }
        } else if idle.isAnimationPlaying {
            idle.stop()
        }
        locking.currentProgress = min(1, max(0, lockness))
    }

    private func paint() {
        let color = UIColor(Palette.Record.lock).resolvedColor(with: traitCollection).lottieColorValue
        for view in [idle, locking] {
            view.setValueProvider(ColorValueProvider(color), keypath: AnimationKeypath(keypath: "**.Color"))
        }
    }

    /// Telegram's `Lock` and `LockWait`, read once.
    private static let lockAnimation = animation("record-lock")
    private static let idleAnimation = animation("record-lock-wait")

    private static func animation(_ name: String) -> LottieAnimation? {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json")
            ?? Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Animations"),
            let data = try? Data(contentsOf: url)
        else { return nil }
        return try? LottieAnimation.from(data: data)
    }
}
#endif
