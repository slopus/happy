#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Desktop's working line (`AgentWorkingStatus`) at the transcript's foot:
/// the braille loader, the turn's clock, a "·", and the phase under the
/// calm sheen shimmer, changing in place as the agent's status moves. A
/// scheduled wait takes the loader's column with its ring and counts down;
/// a question waiting on the person shows the red question mark, still.
///
/// Nothing here draws per frame on the main thread: the loader's dots and
/// the shimmer's band are layer animations the render server runs at the
/// display's rate, and the clock is a once-a-second timer, ticking on the
/// turn's own seconds.
final class WorkingView: UIView {
    private let loader = BrailleView()
    private let ring = WaitRingView()
    private let icon = UIImageView()
    private let timer = UILabel()
    private let separator = UILabel()
    private let phase = ShimmerLabel()
    private var clock: Timer?
    private(set) var activity: Activity?

    private static var font: UIFont { Fonts.ui(.regular, size: WorkingLayout.Metrics.fontSize) }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = true
        accessibilityTraits = .updatesFrequently
        accessibilityIdentifier = "working"
        let ink = UIColor(Palette.workingText)
        loader.tintColor = ink
        ring.tintColor = ink
        timer.font = Fonts.tabular(Self.font)
        timer.textColor = ink
        timer.textAlignment = .right
        separator.font = Self.font
        separator.textColor = UIColor(Palette.workingSeparator)
        separator.text = Strings.workingSeparator
        phase.textColor = ink
        phase.ground = UIColor(Palette.surface)
        for view in [loader, ring, icon, timer, separator, phase] { addSubview(view) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ activity: Activity?) {
        let previous = self.activity
        self.activity = activity
        isHidden = activity == nil
        guard let activity else {
            phase.shimmering = false
            loader.running = false
            stopClock()
            return
        }
        var glyph: UIImage?
        var glyphTint = UIColor(Palette.workingText)
        switch activity.phase {
        case .awaitingAnswer:
            glyph = Glyphs.image("question", size: WorkingLayout.Metrics.column)
            glyphTint = UIColor(Palette.question)
        default:
            break
        }
        icon.image = glyph
        icon.tintColor = glyphTint
        icon.isHidden = glyph == nil
        let waiting = if case .waiting = activity.phase { true } else { false }
        ring.isHidden = !waiting
        loader.isHidden = glyph != nil || waiting
        loader.running = !loader.isHidden
        // Only work in progress shimmers; a question or a wait is still.
        let still = glyph != nil || waiting
        phase.shimmering = !still
        if previous == nil || previous?.startedAt != activity.startedAt || Self.waitDue(previous) != Self.waitDue(activity) { startClock() }
        tick()
    }

    /// The parts that change with time: the clock, a wait's ring and
    /// countdown. The phase's own words change only with the activity.
    private func tick() {
        guard let activity else { return }
        let now = Date().timeIntervalSince1970 * 1000
        timer.text = activity.startedAt.map { Elapsed.text(milliseconds: now - $0) }
        let text: String = switch activity.phase {
        case .waitingForModel: Strings.phaseWaitingForModel
        case .thinking: Strings.phaseThinking
        case .preparingTools: Strings.phasePreparingTools
        case .runningTools: Strings.phaseRunningTools
        case .working: Strings.phaseWorking
        case .delegating: Strings.phaseDelegating
        case .awaitingAnswer: Strings.phaseAwaitingAnswer
        case .retrying(let retry): Strings.phaseRetrying(kind: retry.kind, vendor: retry.vendorName, attempt: retry.attempt, of: retry.maxAttempts)
        case .waiting(let wait):
            wait.dueAt > now ? Strings.phaseWaitFor(Elapsed.remaining(milliseconds: wait.dueAt - now)) : Strings.phaseWaitEnding
        }
        if case .waiting(let wait) = activity.phase {
            let span = wait.dueAt - wait.startedAt
            ring.progress = span > 0 ? min(1, max(0, (now - wait.startedAt) / span)) : 1
        }
        if phase.attributedText?.string != text {
            phase.attributedText = NSAttributedString(string: text, attributes: [.font: Self.font])
        }
        let shownTimer = timer.text.map { "\($0) \(Strings.workingSeparator) " } ?? ""
        accessibilityLabel = shownTimer + text
        setNeedsLayout()
    }

    private static func waitDue(_ activity: Activity?) -> Double? {
        if case .waiting(let wait) = activity?.phase { wait.dueAt } else { nil }
    }

    /// Ticks as each second turns over: a wait's own, counting down to its
    /// end, else the turn's. Nothing ticks where nothing on the line moves.
    private func startClock() {
        stopClock()
        guard window != nil, let activity else { return }
        let due = Self.waitDue(activity)
        guard let origin = due ?? activity.startedAt else { return }
        let now = Date().timeIntervalSince1970 * 1000
        let into = (now - origin).truncatingRemainder(dividingBy: 1000)
        let first = Date(timeIntervalSinceNow: (1000 - (into < 0 ? into + 1000 : into)) / 1000)
        let clock = Timer(fire: first, interval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        clock.tolerance = 0.02
        RunLoop.main.add(clock, forMode: .common)
        self.clock = clock
    }

    private func stopClock() {
        clock?.invalidate()
        clock = nil
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { stopClock() } else if activity != nil { startClock(); tick() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let activity else { return }
        let marked = loader.isHidden
        let timed = activity.startedAt != nil
        let layout = WorkingLayout(
            width: bounds.width, glyph: marked ? .mark : .loader,
            timer: timed ? Self.width(timer) : nil,
            separator: timed ? Self.width(separator) : nil,
            // All the room left: the label ends its own line, never cut short by a rounding.
            phase: .greatestFiniteMagnitude
        )
        loader.frame = layout.glyph
        ring.frame = layout.glyph
        icon.frame = layout.glyph
        timer.isHidden = layout.timer == nil
        separator.isHidden = layout.separator == nil
        if let frame = layout.timer { timer.frame = frame }
        if let frame = layout.separator { separator.frame = frame }
        phase.frame = layout.phase
    }

    /// The text's own advance, unrounded.
    private static func width(_ label: UILabel) -> CGFloat {
        ((label.text ?? "") as NSString).size(withAttributes: [.font: label.font as Any]).width
    }
}

/// Desktop's `braille-2` loader (`spinnerBrailleCanvas.ts`) on the screen's
/// own pixels: one hard round stamp sized for this scale, copied to eight
/// whole-pixel origins, so no dot ever looks larger than another. Every dot
/// runs the same opacity wave, a tenth of a second apart in `dots2`'s
/// order; each is one keyframe animation the render server plays at up to
/// 120Hz, offset by its phase.
final class BrailleView: UIView {
    private var dots: [CALayer] = []
    private var backgrounded = false
    var animating: Bool { dots.first?.animation(forKey: "wave") != nil }

    var running = false {
        didSet { if running != oldValue { animate() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        for _ in 0..<Braille.phases.count {
            let dot = CALayer()
            dot.contentsGravity = .topLeft
            dot.magnificationFilter = .nearest
            dot.minificationFilter = .nearest
            layer.addSublayer(dot)
            dots.append(dot)
        }
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.setNeedsLayout() }
        NotificationCenter.default.addObserver(self, selector: #selector(foregrounded), name: UIApplication.willEnterForegroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(wentAway), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(animate), name: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func tintColorDidChange() {
        super.tintColorDidChange()
        setNeedsLayout()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        setNeedsLayout()
        animate()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let scale = window?.screen.scale ?? traitCollection.displayScale
        guard scale > 0, bounds.width > 0 else { return }
        let width = Int((bounds.width * scale).rounded())
        let height = Int((bounds.height * scale).rounded())
        let (diameter, origins) = Braille.origins(width: width, height: height)
        let color = tintColor.resolvedColor(with: traitCollection)
        let image = Self.stamp(diameter: diameter, scale: scale, color: color)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for (dot, origin) in zip(dots, origins) {
            dot.contents = image
            dot.contentsScale = scale
            dot.frame = CGRect(x: CGFloat(origin.x) / scale, y: CGFloat(origin.y) / scale, width: CGFloat(diameter) / scale, height: CGFloat(diameter) / scale)
        }
        CATransaction.commit()
    }

    /// The stamp, one pixel row at a time.
    private static func stamp(diameter: Int, scale: CGFloat, color: UIColor) -> CGImage? {
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = false
        let size = CGSize(width: CGFloat(diameter) / scale, height: CGFloat(diameter) / scale)
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            color.setFill()
            for (y, span) in Braille.stamp(diameter: diameter).enumerated() where span.length > 0 {
                context.fill(CGRect(x: CGFloat(span.start) / scale, y: CGFloat(y) / scale, width: CGFloat(span.length) / scale, height: 1 / scale))
            }
        }.cgImage
    }

    @objc private func wentAway() { backgrounded = true; animate() }
    @objc private func foregrounded() { backgrounded = false; animate() }

    @objc private func animate() {
        for dot in dots { dot.removeAnimation(forKey: "wave") }
        guard running, window != nil, !backgrounded, !UIAccessibility.isReduceMotionEnabled else { return }
        let start = CACurrentMediaTime()
        let cycle = Braille.cycle / 1000
        for (dot, phase) in zip(dots, Braille.phases) {
            let wave = CAKeyframeAnimation(keyPath: "opacity")
            wave.values = Braille.keyframes.map { NSNumber(value: $0.opacity) }
            wave.keyTimes = Braille.keyframes.map { NSNumber(value: $0.time) }
            wave.calculationMode = .linear
            wave.duration = cycle
            wave.repeatCount = .infinity
            wave.beginTime = start
            // opacity(t - phase): the dot's own time runs a phase behind.
            let lag = Double(phase) * Braille.frame / 1000
            wave.timeOffset = (cycle - lag).truncatingRemainder(dividingBy: cycle)
            wave.isRemovedOnCompletion = false
            wave.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
            dot.add(wave, forKey: "wave")
        }
    }
}

/// Desktop's `WaitRing`: the share of a scheduled wait already spent, as an
/// arc filling clockwise from the top over a quiet track, 2 wide.
final class WaitRingView: UIView {
    private let track = CAShapeLayer()
    private let fill = CAShapeLayer()

    var progress: Double = 0 {
        didSet {
            CATransaction.begin(); CATransaction.setDisableActions(true)
            fill.strokeEnd = progress
            CATransaction.commit()
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        for shape in [track, fill] {
            shape.fillColor = nil
            shape.lineWidth = WorkingLayout.Metrics.ringStroke
            layer.addSublayer(shape)
        }
        fill.lineCap = .round
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.colour() }
        colour()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func tintColorDidChange() {
        super.tintColorDidChange()
        colour()
    }

    private func colour() {
        track.strokeColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
        fill.strokeColor = tintColor.resolvedColor(with: traitCollection).cgColor
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let radius = WorkingLayout.ringRadius(bounds.size)
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        let path = UIBezierPath(arcCenter: center, radius: radius, startAngle: -.pi / 2, endAngle: 1.5 * .pi, clockwise: true).cgPath
        track.path = path
        fill.path = path
    }
}
#endif
