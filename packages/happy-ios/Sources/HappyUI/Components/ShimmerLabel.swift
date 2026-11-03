#if canImport(UIKit)
import HappyLayout
import UIKit

/// The one clock every shimmer in the app keeps (`Shimmer`): each sweep
/// begins at `epoch`, so neighbouring labels move together and a band that
/// stops and starts again picks up where the clock is, never from the
/// start. It also says when nothing may sweep: in the background, asked
/// for less motion, in Low Power Mode, or with the phone hot. Every band
/// hears from it when that changes, and the working line's dots
/// (`BrailleView`) from `changedNotification`.
@MainActor
final class ShimmerClock {
    static let shared = ShimmerClock()

    /// Posted on the main thread when `holdsStill` or the background may have changed.
    static let changedNotification = Notification.Name("ShimmerClock.changed")

    /// What a working signal (a sweep, the dots) asks of the display. They
    /// move slowly, so 30 Hz draws them as smoothly as 120 does while the
    /// screen rests: asking for 120 kept a ProMotion panel there, and the
    /// render server compositing every frame, for as long as an agent worked.
    static let ambientRate = CAFrameRateRange(minimum: 10, maximum: 30, preferred: 30)

    let epoch = CACurrentMediaTime()
    private(set) var backgrounded = UIApplication.shared.applicationState == .background
    private let bands = NSHashTable<ShimmerBand>.weakObjects()

    /// Fixtures and screenshots: every band parked at this point of the
    /// loop (`ShimmerText`'s `phase`), 0 and 1 clear of the text.
    var frozenPhase: Double? {
        didSet { if frozenPhase != oldValue { changed() } }
    }

    /// Tests stand in for the system's Reduce Motion with this.
    var reduceMotionOverride: Bool? {
        didSet { if reduceMotionOverride != oldValue { changed() } }
    }

    /// Asked for less motion, the text simply stays at its own colour.
    var reducesMotion: Bool { reduceMotionOverride ?? UIAccessibility.isReduceMotionEnabled }

    /// Tests stand in for Low Power Mode or a hot phone with this.
    var savingOverride: Bool? {
        didSet { if savingOverride != oldValue { changed() } }
    }

    /// Low Power Mode, or the phone serious or critical: nothing ambient
    /// moves, as with Reduce Motion.
    var saving: Bool {
        savingOverride ?? (ProcessInfo.processInfo.isLowPowerModeEnabled || ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.serious.rawValue)
    }

    /// Whether working signals stand still, the text at its own colour.
    var holdsStill: Bool { reducesMotion || saving }

    private init() {
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(changed), name: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil)
        // Both are posted on whichever thread noticed.
        for name in [Notification.Name.NSProcessInfoPowerStateDidChange, ProcessInfo.thermalStateDidChangeNotification] {
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.changed() }
            }
        }
        center.addObserver(self, selector: #selector(wentAway), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(cameBack), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    func register(_ band: ShimmerBand) { bands.add(band) }

    @objc private func wentAway() { backgrounded = true; changed() }
    @objc private func cameBack() { backgrounded = false; changed() }

    @objc private func changed() {
        for band in bands.allObjects { band.clockChanged() }
        NotificationCenter.default.post(name: Self.changedNotification, object: self)
    }
}

/// A shimmer's travelling band alone (`Shimmer`): a copy of the text in
/// the band's colour, laid exactly over the text at rest and masked by the
/// ramp, which one layer animation slides across on the render server.
/// Nothing runs per frame here. It sweeps only while `shimmering`, in a
/// window, `onScreen`, in the foreground and with motion allowed; else
/// it is hidden and its animation removed.
///
/// `ShimmerLabel` keeps one over its text. A list that draws its rows
/// into bitmaps (UltraView) lays one over a drawn title as an overlay,
/// giving it the copy as a drawing (`init(frame:run:draw:)`), rendered off
/// the main thread.
final class ShimmerBand: UIView {
    private let ramp = CAGradientLayer()
    private let clock = ShimmerClock.shared
    /// The copy: a label, or the drawing's picture.
    private(set) var copy: UIView
    private var drawJob: Task<Void, Never>?

    var shimmering = false {
        didSet { if shimmering != oldValue { setNeedsLayout(); update() } }
    }

    /// False where whatever holds the text has it scrolled out of sight.
    var onScreen = true {
        didSet { if onScreen != oldValue { update() } }
    }

    /// The text as drawn in this view's bounds: where the band runs.
    var run: CGRect = .zero {
        didSet { if run != oldValue { placeRamp() } }
    }

    /// When the running sweep's clock began; nil while it doesn't run.
    var sweepBegan: CFTimeInterval? { ramp.animation(forKey: Self.key)?.beginTime }

    /// The ramp's middle as the running sweep goes (tests).
    var sweepSpan: (from: CGFloat, to: CGFloat)? {
        guard let sweep = ramp.animation(forKey: Self.key) as? CABasicAnimation,
              let from = sweep.fromValue as? CGFloat, let to = sweep.toValue as? CGFloat else { return nil }
        return (from, to)
    }

    var sweeps: Bool {
        shimmering && onScreen && window != nil && !clock.backgrounded && !clock.holdsStill
    }

    private static let key = "sweep"

    init(copy: UIView) {
        self.copy = copy
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        accessibilityElementsHidden = true
        addSubview(copy)
        ramp.startPoint = CGPoint(x: 0, y: 0.5)
        ramp.endPoint = CGPoint(x: 1, y: 0.5)
        ramp.colors = [UIColor.clear.cgColor, UIColor.white.cgColor, UIColor.clear.cgColor]
        ramp.locations = Shimmer.bandStops.map { NSNumber(value: $0) }
        layer.mask = ramp
        isHidden = true
        clock.register(self)
    }

    /// A band over text something else drew, at `frame` in its overlay:
    /// `draw` paints the text in the band's colour where it stands in that
    /// frame, off the main thread; `run` is the text in the frame.
    convenience init(frame: CGRect, run: CGRect, scale: CGFloat, draw: @escaping @Sendable (CGContext) -> Void) {
        let picture = UIImageView(frame: CGRect(origin: .zero, size: frame.size))
        self.init(copy: picture)
        self.frame = frame
        self.run = run
        let size = frame.size
        drawJob = Task { [weak picture] in
            let image = await Task.detached(priority: .userInitiated) {
                let format = UIGraphicsImageRendererFormat()
                format.scale = scale
                format.opaque = false
                return UIGraphicsImageRenderer(size: size, format: format).image { draw($0.cgContext) }
            }.value
            picture?.image = image
        }
        shimmering = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit { drawJob?.cancel() }

    override func layoutSubviews() {
        super.layoutSubviews()
        copy.frame = bounds
        placeRamp()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // Out of the window the band stops; back in, it picks up the clock.
        update()
    }

    /// What else hears when the clock changes: a `lift` label recolours.
    var onClockChange: (() -> Void)?

    func clockChanged() {
        update()
        onClockChange?()
    }

    private func placeRamp() {
        guard shimmering, let band = Shimmer.band(run: run, box: bounds.size) else { return }
        let size = band.size
        CATransaction.begin(); CATransaction.setDisableActions(true)
        ramp.bounds = CGRect(origin: .zero, size: size)
        ramp.position = CGPoint(x: band.fromX, y: band.midY)
        CATransaction.commit()
        if sweeps { start(band) }
    }

    private func update() {
        isHidden = !sweeps
        if sweeps { placeRamp() } else { ramp.removeAnimation(forKey: Self.key) }
    }

    private func start(_ band: Shimmer.Band) {
        let frozen = clock.frozenPhase
        // Already running this sweep: nothing to start again.
        if let running = ramp.animation(forKey: Self.key) as? CABasicAnimation,
           running.fromValue as? CGFloat == band.fromX, running.toValue as? CGFloat == band.toX,
           (running.speed == 0) == (frozen != nil), frozen == nil || running.timeOffset == frozen! * Shimmer.duration {
            return
        }
        ramp.removeAnimation(forKey: Self.key)
        let sweep = CABasicAnimation(keyPath: "position.x")
        sweep.fromValue = band.fromX
        sweep.toValue = band.toX
        sweep.duration = Shimmer.duration
        sweep.repeatCount = .infinity
        sweep.isRemovedOnCompletion = false
        if let frozen {
            sweep.speed = 0
            sweep.timeOffset = frozen * Shimmer.duration
        } else {
            sweep.beginTime = ramp.convertTime(clock.epoch, from: nil)
        }
        sweep.preferredFrameRateRange = ShimmerClock.ambientRate
        ramp.add(sweep, forKey: Self.key)
    }
}

/// One line of text that can carry desktop's ShimmerText (`Shimmer`): the
/// text at rest, and while `shimmering` a `ShimmerBand` over it. `sheen`
/// keeps the letters at their own colour under a pale band; `lift` dims
/// them (only while the band can run) under one at full strength. The
/// letters never move or reflow. A plain title costs nothing: the band is
/// neither measured nor drawn until the text shimmers.
///
/// Given attributed text (`init()`), its colours are `textColor` and
/// `ground`. Given a style (`init(style:)`), it draws as `StyledLabel`
/// does, in `color`, and measures as one.
final class ShimmerLabel: UIView {
    private let base: UILabel
    private let copy: UILabel
    let band: ShimmerBand

    init(makeLabel: () -> UILabel = { UILabel() }) {
        base = makeLabel()
        copy = makeLabel()
        band = ShimmerBand(copy: copy)
        super.init(frame: .zero)
        setUp()
    }

    override convenience init(frame: CGRect) {
        self.init(makeLabel: { UILabel() })
        self.frame = frame
    }

    /// Drawn in `style`, one line, as `StyledLabel` draws it.
    init(style: TextStyle, lines: Int = 1) {
        base = StyledLabel(style: style, color: Palette.text, lines: lines)
        copy = StyledLabel(style: style, color: Palette.text, lines: lines)
        band = ShimmerBand(copy: copy)
        super.init(frame: .zero)
        textColor = UIColor(Palette.text)
        setUp()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func setUp() {
        isUserInteractionEnabled = false
        for label in [base, copy] {
            label.lineBreakMode = .byTruncatingTail
            if !(label is StyledLabel) { label.numberOfLines = 1 }
        }
        addSubview(base)
        addSubview(band)
        band.onClockChange = { [weak self] in self?.applyColors() }
        applyColors()
    }

    // MARK: Text

    /// The label that draws the text at rest: what VoiceOver reads.
    var textLabel: UILabel { base }

    var attributedText: NSAttributedString? {
        didSet {
            guard attributedText != oldValue else { return }
            applyColors()
            setNeedsLayout()
        }
    }

    /// A styled label's words.
    var string: String {
        get { (base as? StyledLabel)?.string ?? attributedText?.string ?? "" }
        set {
            guard let base = base as? StyledLabel, let copy = copy as? StyledLabel, newValue != base.string else { return }
            base.string = newValue
            copy.string = newValue
            setNeedsLayout()
        }
    }

    /// A styled label's style.
    var style: TextStyle? {
        get { (base as? StyledLabel)?.style }
        set {
            guard let newValue, let base = base as? StyledLabel, let copy = copy as? StyledLabel else { return }
            base.style = newValue
            copy.style = newValue
            setNeedsLayout()
        }
    }

    /// The text's own colour: what `inherit` builds the ramp from.
    var textColor: UIColor = .label {
        didSet { if textColor != oldValue { applyColors() } }
    }

    /// A styled label's own colour.
    var color: ColorToken {
        get { ColorToken(textColor) }
        set { textColor = UIColor(newValue) }
    }

    /// The surface behind the text, which the ramp mixes toward.
    var ground: UIColor = UIColor(Palette.surface) {
        didSet { if ground != oldValue { applyColors() } }
    }

    var sweep: Shimmer.Sweep = .sheen {
        didSet { if sweep != oldValue { applyColors() } }
    }

    var tone: Shimmer.Tone = .inherit {
        didSet { if tone != oldValue { applyColors() } }
    }

    var shimmering = false {
        didSet {
            guard shimmering != oldValue else { return }
            band.shimmering = shimmering
            applyColors()
            setNeedsLayout()
        }
    }

    /// False where whatever holds the text has it scrolled out of sight.
    var onScreen: Bool {
        get { band.onScreen }
        set { band.onScreen = newValue }
    }

    /// When the running sweep's clock began; nil while it doesn't run.
    var sweepBegan: CFTimeInterval? { band.sweepBegan }

    var alignment: NSTextAlignment {
        get { base.textAlignment }
        set { base.textAlignment = newValue; copy.textAlignment = newValue; setNeedsLayout() }
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize { base.sizeThatFits(size) }

    override var intrinsicContentSize: CGSize { base.intrinsicContentSize }

    // MARK: Colour

    /// The letters' colour now: `lift` rests dimmed only while its band
    /// can run, so held still the text is simply its colour.
    private var restsDimmed: Bool { shimmering && sweep == .lift && !ShimmerClock.shared.holdsStill }

    private func applyColors() {
        let ink = tone == .inherit ? textColor : UIColor(Shimmer.ink(tone, own: .clear))
        let ground = ground
        let sweep = sweep
        let rest = restsDimmed ? Self.dynamic(ink, ground) { Shimmer.rest(sweep, ink: $0, ground: $1) } : ink
        let highlight = Self.dynamic(ink, ground) { Shimmer.highlight(sweep, ink: $0, ground: $1) }
        if let base = base as? StyledLabel, let copy = copy as? StyledLabel {
            base.color = ColorToken(rest)
            copy.color = ColorToken(highlight)
            return
        }
        guard let text = attributedText, text.length > 0 else {
            base.attributedText = nil
            copy.attributedText = nil
            return
        }
        for (label, color) in [(base, rest), (copy, highlight)] {
            let colored = NSMutableAttributedString(attributedString: text)
            colored.addAttribute(.foregroundColor, value: color, range: NSRange(location: 0, length: colored.length))
            label.attributedText = colored
        }
    }

    /// A colour built from two others in each appearance.
    private static func dynamic(_ ink: UIColor, _ ground: UIColor, _ make: @escaping @Sendable (RGBA, RGBA) -> RGBA) -> UIColor {
        UIColor { traits in UIColor(make(RGBA(ink.resolvedColor(with: traits)), RGBA(ground.resolvedColor(with: traits)))) }
    }

    // MARK: Layout

    override func layoutSubviews() {
        super.layoutSubviews()
        base.frame = bounds
        band.frame = bounds
        // A still title measures nothing for a band it doesn't draw.
        guard shimmering else { return }
        band.run = Self.run(of: base, in: bounds)
    }

    /// Where the label draws its one line in `bounds`.
    private static func run(of label: UILabel, in bounds: CGRect) -> CGRect {
        let text = label.textRect(forBounds: bounds, limitedToNumberOfLines: 1)
        let width = min(text.width, bounds.width)
        var alignment = label.textAlignment
        if let text = label.attributedText, text.length > 0,
           let paragraph = text.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle {
            alignment = paragraph.alignment
        }
        let rtl = label.effectiveUserInterfaceLayoutDirection == .rightToLeft
        let x: CGFloat = switch alignment {
        case .center: (bounds.width - width) / 2
        case .right: bounds.width - width
        case .natural, .justified: rtl ? bounds.width - width : 0
        default: 0
        }
        return CGRect(x: x, y: 0, width: width, height: bounds.height)
    }
}

extension RGBA {
    init(_ color: UIColor) {
        var (red, green, blue, alpha): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        self.init(red: Double(red), green: Double(green), blue: Double(blue), alpha: Double(alpha))
    }
}

extension ColorToken {
    /// A dynamic colour's two appearances.
    init(_ color: UIColor) {
        self.init(
            light: RGBA(color.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))),
            dark: RGBA(color.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark)))
        )
    }
}
#endif
