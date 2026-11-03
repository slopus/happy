#if canImport(UIKit)
import HappyLayout
import QuartzCore
import UIKit

/// The call bar's ground: `CallWaves`' three crests, each a gradient
/// masked by its shape, bottom to top at 35, 55 and 100% opacity, so the
/// top one is the bar and the two below show past its edge. It animates
/// only while it is in a window, the app is active, the waves aren't flat
/// and neither Reduce Motion nor Low Power Mode is on; otherwise it holds
/// the bar's straight edge.
///
/// Adapted from Telegram-iOS `TelegramCallsUI/Sources/CallStatusBarNode.swift`
/// (`CallStatusBarBackgroundNode`: per-state gradient colours, animated
/// between states; waves only while in the hierarchy) (permission from Steve).
final class CallWavesView: UIView {
    /// The bar's bottom edge, where the crests rest; the view runs
    /// `CallWaves.overhang` below it.
    var restY: CGFloat = 0 {
        didSet { if restY != oldValue { redraw() } }
    }
    /// Still: the call isn't live, or it shouldn't move.
    var isFlat = true {
        didSet { if isFlat != oldValue { updateRunning(); redraw() } }
    }

    private var model = CallWaves()
    private let gradients = CallWaves.alphas.map { _ in CAGradientLayer() }
    private let masks = CallWaves.alphas.map { _ in CAShapeLayer() }
    private var link: CADisplayLink?
    private var last: CFTimeInterval?
    private var gradient = Palette.CallBar.connecting

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isOpaque = false
        for (index, layer) in gradients.enumerated() {
            layer.startPoint = CGPoint(x: 0, y: 0.5)
            // Over twice the width, as Telegram's gradient runs.
            layer.endPoint = CGPoint(x: 2, y: 0.5)
            layer.opacity = Float(CallWaves.alphas[index])
            layer.mask = masks[index]
            self.layer.addSublayer(layer)
        }
        apply(gradient, animated: false)
        let center = NotificationCenter.default
        for name in [UIAccessibility.reduceMotionStatusDidChangeNotification, Notification.Name.NSProcessInfoPowerStateDidChange,
                     UIApplication.didBecomeActiveNotification, UIApplication.willResignActiveNotification] {
            center.addObserver(self, selector: #selector(conditionsChanged), name: name, object: nil)
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Low Power Mode's change comes on any thread.
    @objc private nonisolated func conditionsChanged() {
        Task { @MainActor [weak self] in
            self?.updateRunning()
            self?.redraw()
        }
    }

    /// The call's level, from what it reported (`CallLevel`).
    func update(level: Double) {
        model.update(level: CGFloat(level))
    }

    func apply(_ colors: CallBarGradient, animated: Bool) {
        let previous = gradient
        gradient = colors
        let new = [UIColor(colors.start).cgColor, UIColor(colors.end).cgColor]
        for layer in gradients {
            if animated, previous != colors {
                let animation = CABasicAnimation(keyPath: "colors")
                animation.fromValue = layer.presentation()?.colors ?? layer.colors
                animation.toValue = new
                animation.duration = CallBarMotion.duration
                animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                layer.add(animation, forKey: "colors")
            }
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer.colors = new
            CATransaction.commit()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for layer in gradients { layer.frame = bounds }
        for mask in masks { mask.frame = bounds }
        CATransaction.commit()
        redraw()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        updateRunning()
    }

    /// Whether the waves move now.
    private var moves: Bool {
        !isFlat && window != nil && !UIAccessibility.isReduceMotionEnabled
            && !ProcessInfo.processInfo.isLowPowerModeEnabled
            && UIApplication.shared.applicationState == .active
    }

    private func updateRunning() {
        if moves {
            guard link == nil else { return }
            let link = CADisplayLink(target: WavesTick(self), selector: #selector(WavesTick.tick(_:)))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
            link.add(to: .main, forMode: .common)
            self.link = link
            last = nil
        } else {
            link?.invalidate()
            link = nil
            last = nil
        }
    }

    fileprivate func tick(_ link: CADisplayLink) {
        let now = link.targetTimestamp
        let delta = last.map { min(0.1, max(0, now - $0)) } ?? 1 / 60
        last = now
        model.advance(by: CGFloat(delta))
        redraw()
    }

    private func redraw() {
        guard bounds.width > 0 else { return }
        let crests = model.crests(width: bounds.width, restY: restY, flat: !moves)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (index, crest) in crests.enumerated() {
            let path = CGMutablePath()
            path.move(to: CGPoint(x: 0, y: 0))
            path.addLine(to: crest.start)
            for segment in crest.segments {
                path.addCurve(to: segment.to, control1: segment.control1, control2: segment.control2)
            }
            path.addLine(to: CGPoint(x: bounds.width, y: 0))
            path.closeSubpath()
            masks[index].path = path
        }
        CATransaction.commit()
    }
}

/// The display link's target, so the link doesn't keep the view alive.
private final class WavesTick: NSObject {
    weak var view: CallWavesView?
    init(_ view: CallWavesView) { self.view = view }
    @MainActor @objc func tick(_ link: CADisplayLink) {
        guard let view else { return link.invalidate() }
        view.tick(link)
    }
}
#endif
