#if canImport(UIKit)
import HappyLayout
import UIKit

/// Scenes drifting down the sides of a setup page, over its gradient and
/// under its content: desktop's SetupDrift. Each fades in after its own
/// wait, its animation playing once as it does and holding its last frame
/// (animated emoji never loop), then wanders slowly there and back for as
/// long as the page is up. Pure decoration: no touches, nothing read out,
/// and still under Reduce Motion. `SetupDriftLayout` places them, clear of
/// `avoid`; the picks are drawn once, so a rotation only moves them. A
/// scene goes on screen only as it fades in (`StateSceneView.waits`), so
/// the page's push isn't building six of them at once.
final class SetupDriftView: UIView {
    private let scenes: [StateSceneView]
    private let draws: [SetupDriftLayout.Draw]
    /// What they keep clear of, in this view's coordinates.
    var avoid: [CGRect] = [] {
        didSet { if avoid != oldValue { setNeedsLayout() } }
    }
    /// The page is showing: only then do they come in and wander.
    var isRunning = false {
        didSet {
            guard isRunning != oldValue else { return }
            if isRunning { start() } else { stop() }
        }
    }
    private var layout: SetupDriftLayout?
    /// Each scene's wander running now, so a new one restarts it.
    private var wandering: [Int: CGVector] = [:]
    private var arrived: Set<Int> = []

    init(scenes: [StateScene]) {
        self.scenes = scenes.map { StateSceneView(scene: $0, size: SetupDriftLayout.Metrics.sizes.upperBound, play: .onDemand, replayLabel: "") }
        draws = scenes.map { _ in SetupDriftLayout.Draw.random() }
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        accessibilityElementsHidden = true
        for scene in self.scenes {
            scene.waits = true
            scene.alpha = 0
            scene.isHidden = true
            addSubview(scene)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(motionChanged), name: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = SetupDriftLayout(size: bounds.size, safeArea: LayoutInsets(safeAreaInsets), avoid: avoid, draws: draws)
        self.layout = layout
        let shown = Dictionary(uniqueKeysWithValues: layout.items.map { ($0.scene, $0) })
        for (index, scene) in scenes.enumerated() {
            guard let item = shown[index] else {
                scene.isHidden = true
                continue
            }
            scene.isHidden = false
            // Placed by bounds and centre: the wander is its transform.
            scene.bounds = CGRect(origin: .zero, size: item.frame.size)
            scene.center = CGPoint(x: item.frame.midX, y: item.frame.midY)
        }
        if isRunning { start() }
    }

    /// Fades in what hasn't come in yet, and sets each wandering.
    private func start() {
        guard let layout else { return }
        let still = UIAccessibility.isReduceMotionEnabled
        for item in layout.items {
            let scene = scenes[item.scene]
            if !arrived.contains(item.scene) {
                arrived.insert(item.scene)
                if still {
                    scene.waits = false
                    scene.alpha = SetupDriftLayout.Metrics.opacity
                } else {
                    let index = item.scene
                    DispatchQueue.main.asyncAfter(deadline: .now() + item.delay) { [weak self] in self?.fadeIn(index) }
                }
            }
            guard !still, wandering[item.scene] != item.offset else { continue }
            wandering[item.scene] = item.offset
            scene.layer.removeAnimation(forKey: "transform")
            scene.transform = .identity
            let delay = scene.alpha > 0 ? 0 : item.delay
            UIView.animate(withDuration: item.duration, delay: delay, options: [.repeat, .autoreverse, .curveEaseInOut]) {
                scene.transform = CGAffineTransform(translationX: item.offset.dx, y: item.offset.dy)
            }
        }
    }

    /// A scene's turn: on screen, fading in, playing once. Off screen by
    /// then, it waits for the page to show again.
    private func fadeIn(_ index: Int) {
        guard isRunning else {
            arrived.remove(index)
            return
        }
        let scene = scenes[index]
        scene.waits = false
        UIView.animate(withDuration: SetupDriftLayout.Metrics.fade, delay: 0, options: [.curveEaseOut]) {
            scene.alpha = SetupDriftLayout.Metrics.opacity
        }
        scene.replay()
    }

    /// Off screen: the wandering stops where it started.
    private func stop() {
        // A fade cut short lands where it was going.
        for scene in scenes {
            scene.layer.removeAllAnimations()
            scene.transform = .identity
        }
        wandering = [:]
    }

    @objc private func motionChanged() {
        stop()
        if UIAccessibility.isReduceMotionEnabled {
            for index in arrived {
                scenes[index].waits = false
                scenes[index].alpha = SetupDriftLayout.Metrics.opacity
            }
        }
        if isRunning { start() }
    }
}
#endif
