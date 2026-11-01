#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The loading bar under the browser's header: draws a `BrowserProgress`,
/// gliding to each new value, filling and then fading when the load ends.
/// `faded` tells the screen the fade is over, so it can hide the model.
@MainActor
final class BrowserProgressView: UIView {
    private let fill = UIView()
    private var shown = BrowserProgress()
    var faded: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        accessibilityIdentifier = "browser-progress"
        fill.backgroundColor = UIColor(Palette.browserProgress)
        fill.layer.cornerRadius = BrowserMetrics.progressHeight / 2
        fill.layer.maskedCorners = [.layerMaxXMinYCorner, .layerMaxXMaxYCorner]
        addSubview(fill)
        alpha = 0
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// How much of the bar is filled, as drawn (tests).
    var fraction: Double { shown.value }

    func apply(_ progress: BrowserProgress, animated: Bool) {
        let before = shown
        shown = progress
        guard window != nil, animated else {
            layer.removeAllAnimations(); fill.layer.removeAllAnimations()
            alpha = progress.phase == .loading ? 1 : 0
            fill.frame = fillFrame(progress.value)
            if progress.phase == .finishing { faded?() }
            return
        }
        switch progress.phase {
        case .hidden:
            UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState]) { self.alpha = 0 } completion: { done in
                if done, self.shown.phase == .hidden { self.fill.frame = self.fillFrame(0) }
            }
        case .loading:
            if before.phase != .loading {
                // A new load: the old one's fade is dropped, and the bar
                // grows from nothing.
                layer.removeAllAnimations(); fill.layer.removeAllAnimations()
                alpha = 1
                fill.frame = fillFrame(0)
            }
            UIView.animate(withDuration: 0.3, delay: 0, options: [.beginFromCurrentState, .curveEaseOut, .allowUserInteraction]) {
                self.fill.frame = self.fillFrame(progress.value)
            }
        case .finishing:
            alpha = 1
            UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
                self.fill.frame = self.fillFrame(1)
            } completion: { _ in
                guard self.shown.phase == .finishing else { return }
                UIView.animate(withDuration: 0.25, delay: 0.1, options: [.beginFromCurrentState]) { self.alpha = 0 } completion: { _ in
                    if self.shown.phase == .finishing { self.faded?() }
                }
            }
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if fill.layer.animationKeys()?.isEmpty ?? true { fill.frame = fillFrame(shown.value) }
    }

    private func fillFrame(_ value: Double) -> CGRect {
        BrowserLayout.progressFill(bar: bounds.size, value: value)
    }
}
#endif
