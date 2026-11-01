#if canImport(UIKit)
import HappyLayout
import UIKit

/// The check-off: over a todo's box, the fill springs in from the middle
/// and the check mark draws itself, then the view goes. The row under it
/// is drawn done by then (`TodoListInput.settling`), so nothing jumps.
@MainActor
final class TodoCheckPop: UIView {
    private let fill = CAShapeLayer()
    private let mark = CAShapeLayer()

    static let duration: CFTimeInterval = 0.32

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        let bounds = CGRect(origin: .zero, size: frame.size)
        fill.path = UIBezierPath(ovalIn: bounds).cgPath
        fill.frame = bounds
        layer.addSublayer(fill)
        let path = UIBezierPath()
        let w = bounds.width
        path.move(to: CGPoint(x: w * 0.28, y: w * 0.52))
        path.addLine(to: CGPoint(x: w * 0.44, y: w * 0.67))
        path.addLine(to: CGPoint(x: w * 0.73, y: w * 0.36))
        mark.path = path.cgPath
        mark.fillColor = nil
        mark.lineWidth = 2
        mark.lineCap = .round
        mark.lineJoin = .round
        mark.frame = bounds
        layer.addSublayer(mark)
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func applyColors() {
        fill.fillColor = UIColor(Palette.todoCheck).cgColor
        mark.strokeColor = UIColor(Palette.onAccent).cgColor
    }

    /// Plays over `frame` in `host`, then takes itself away.
    static func play(in host: UIView, at frame: CGRect) {
        guard !UIAccessibility.isReduceMotionEnabled else { return }
        let pop = TodoCheckPop(frame: frame)
        host.addSubview(pop)
        let grow = CASpringAnimation(keyPath: "transform.scale")
        grow.fromValue = 0.3
        grow.toValue = 1
        grow.damping = 12
        grow.initialVelocity = 4
        grow.duration = grow.settlingDuration
        pop.fill.add(grow, forKey: "grow")
        let draw = CABasicAnimation(keyPath: "strokeEnd")
        draw.fromValue = 0
        draw.toValue = 1
        draw.beginTime = CACurrentMediaTime() + 0.08
        draw.duration = 0.2
        draw.fillMode = .backwards
        draw.timingFunction = CAMediaTimingFunction(name: .easeOut)
        pop.mark.add(draw, forKey: "draw")
        Task { @MainActor [weak pop] in
            try? await Task.sleep(for: .milliseconds(Int(duration * 1000) + 300))
            pop?.removeFromSuperview()
        }
    }
}
#endif
