#if canImport(UIKit)
import HappyLayout
import UIKit

/// What the call does on screen, shown as the person's own tap would be:
/// the control it stands for lights in the call bar's colours, one band
/// sweeping over it as a working row's title shimmers (`Shimmer`'s ramp),
/// then it presses as under a finger, and only then does the caller act.
/// The control itself is never triggered. Asked for less motion, the
/// light only fades in and the press is the highlight alone.
///
///     (a row off screen glides to the middle first, 0.3 to 0.6 s)
///     0      ramp in (150 ms), the band starting across
///     550    the band has crossed
///     600    pressed
///     750    the action is due: `play` returns
///     750+   the light fades out (250 ms), the press lets go at 900
@MainActor
enum VoiceTouch {
    /// Where the light goes and how the control presses.
    struct Mark {
        /// The view the light is laid in, at `frame` in its bounds.
        var host: UIView
        var frame: CGRect
        var radius: CGFloat
        var corners: CACornerMask = [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMaxYCorner]
        /// Laid just over this subview of `host` (a row's fill, under its
        /// words); else over everything in it.
        var above: UIView?
        /// The press as a finger makes it, and its letting go.
        var press: (_ down: Bool, _ reducesMotion: Bool) -> Void
    }

    static let rampIn: Double = 0.15
    static let sweep: Double = 0.55
    static let pressAt: Double = 0.6
    static let actAt: Double = 0.75
    static let fadeOut: Double = 0.25
    static let releaseAt: Double = 0.9

    static var reducesMotion: Bool { ShimmerClock.shared.reducesMotion }

    /// Lights `mark`, presses it, and returns when the action is due. The
    /// light goes and the press lets go by themselves after.
    static func play(_ mark: Mark) async {
        let light = VoiceTouchLight(frame: mark.frame, radius: mark.radius, corners: mark.corners)
        if let above = mark.above, above.superview === mark.host {
            mark.host.insertSubview(light, aboveSubview: above)
        } else {
            mark.host.addSubview(light)
        }
        let still = reducesMotion
        light.begin(sweeps: !still)
        await pause(pressAt)
        mark.press(true, still)
        light.pressed()
        await pause(actAt - pressAt)
        light.end()
        let press = mark.press
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(releaseAt - actAt))
            press(false, still)
        }
    }

    /// Waits on, even past the tool's deadline: the light never stops
    /// halfway, and what is due after it is the caller's to skip.
    private static func pause(_ seconds: Double) async {
        let end = ContinuousClock.now + .seconds(seconds)
        while ContinuousClock.now < end {
            try? await Task.sleep(until: end, clock: .continuous)
        }
    }

    // MARK: Glass buttons

    /// One of the bars' glass buttons (iOS 26), found by what it holds:
    /// a back button's chevron, or an item. Nil where the bar has none.
    static func glass(in root: UIView, where matches: (UIView) -> Bool) -> UIView? {
        glassButtons(in: root).first(where: matches)
    }

    /// Every glass button under `root`, as the bars lay them out.
    static func glassButtons(in root: UIView) -> [UIView] {
        var found: [UIView] = []
        func walk(_ view: UIView) {
            if String(describing: type(of: view)).contains("GlassInteraction") {
                found.append(view)
                return
            }
            for subview in view.subviews { walk(subview) }
        }
        walk(root)
        return found.filter { !$0.isHidden && $0.alpha > 0.01 && $0.bounds.width > 0 && $0.window != nil }
    }

    /// Whether `view` holds a view whose class name has `part`.
    static func holds(_ view: UIView, _ part: String) -> Bool {
        if String(describing: type(of: view)).contains(part) { return true }
        return view.subviews.contains { holds($0, part) }
    }

    /// Whether a glass button is in the toolbar's floating bar.
    static func inFloatingBar(_ view: UIView) -> Bool {
        var next = view.superview
        while let current = next {
            if String(describing: type(of: current)).contains("FloatingBar") { return true }
            next = current.superview
        }
        return false
    }

    /// A glass button lit and pressed as iOS 26's glass answers a finger:
    /// it swells a little and settles back. A `UIButton` (the iPad
    /// sidebar's compose) also takes its own highlight.
    static func glassMark(_ button: UIView) -> Mark {
        let side = min(button.bounds.width, button.bounds.height)
        return Mark(host: button, frame: button.bounds, radius: side / 2) { [weak button] down, still in
            guard let button else { return }
            (button as? UIControl)?.isHighlighted = down
            guard !still else { return }
            swell(button, down)
        }
    }

    private static func swell(_ view: UIView, _ down: Bool) {
        UIView.animate(withDuration: down ? 0.18 : 0.3, delay: 0, usingSpringWithDamping: down ? 1 : 0.7, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
            view.transform = down ? CGAffineTransform(scaleX: 1.12, y: 1.12) : .identity
        }
    }
}

/// The call's light over a control: its colours faint across the whole
/// shape, and one band of them, `Shimmer`'s ramp, crossing it once.
@MainActor
final class VoiceTouchLight: UIView {
    private let wash = CAGradientLayer()
    private let band = CAGradientLayer()
    private let ramp = CAGradientLayer()

    init(frame: CGRect, radius: CGFloat, corners: CACornerMask) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        accessibilityElementsHidden = true
        accessibilityIdentifier = "voice-touch"
        clipsToBounds = true
        layer.cornerRadius = radius
        layer.cornerCurve = .continuous
        layer.maskedCorners = corners
        let colors = Palette.CallBar.listening
        for gradient in [wash, band] {
            gradient.colors = [UIColor(colors.start).cgColor, UIColor(colors.end).cgColor]
            gradient.startPoint = CGPoint(x: 0, y: 0.5)
            gradient.endPoint = CGPoint(x: 1, y: 0.5)
            gradient.frame = bounds
            gradient.opacity = 0
            layer.addSublayer(gradient)
        }
        ramp.colors = [UIColor.clear.cgColor, UIColor.white.cgColor, UIColor.clear.cgColor]
        ramp.locations = Shimmer.bandStops.map { NSNumber(value: $0) }
        ramp.startPoint = CGPoint(x: 0, y: 0.5)
        ramp.endPoint = CGPoint(x: 1, y: 0.5)
        band.mask = ramp
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private var dark: Bool { traitCollection.userInterfaceStyle == .dark }
    /// How strong the light is at rest and pressed, and the band's middle.
    private var washRest: Float { dark ? 0.22 : 0.12 }
    private var washPressed: Float { dark ? 0.32 : 0.2 }
    private var bandPeak: Float { dark ? 0.55 : 0.4 }

    func begin(sweeps: Bool) {
        fade(wash, to: washRest, over: VoiceTouch.rampIn)
        guard sweeps else { return }
        // The ramp is three widths wide, as a title's is, with the band
        // (its middle fifth) from just clear of the left edge to just
        // clear of the right.
        let width = bounds.width
        let clear = CGFloat(Shimmer.bandStops[2] - Shimmer.bandStops[1]) * Shimmer.rampWidths * width
        ramp.bounds = CGRect(x: 0, y: 0, width: Shimmer.rampWidths * width, height: bounds.height)
        ramp.position = CGPoint(x: -clear, y: bounds.midY)
        band.opacity = bandPeak
        let move = CABasicAnimation(keyPath: "position.x")
        move.fromValue = -clear
        move.toValue = width + clear
        move.duration = VoiceTouch.sweep
        move.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        move.fillMode = .forwards
        move.isRemovedOnCompletion = false
        move.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        ramp.add(move, forKey: "sweep")
    }

    func pressed() {
        fade(wash, to: washPressed, over: 0.1)
    }

    func end() {
        fade(wash, to: 0, over: VoiceTouch.fadeOut)
        fade(band, to: 0, over: VoiceTouch.fadeOut)
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(VoiceTouch.fadeOut + 0.05))
            self?.removeFromSuperview()
        }
    }

    private func fade(_ layer: CALayer, to opacity: Float, over duration: Double) {
        let from = layer.presentation()?.opacity ?? layer.opacity
        layer.opacity = opacity
        let change = CABasicAnimation(keyPath: "opacity")
        change.fromValue = from
        change.toValue = opacity
        change.duration = duration
        change.timingFunction = CAMediaTimingFunction(name: .easeOut)
        layer.add(change, forKey: "fade")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        wash.frame = bounds
        band.frame = bounds
        CATransaction.commit()
    }
}
#endif
