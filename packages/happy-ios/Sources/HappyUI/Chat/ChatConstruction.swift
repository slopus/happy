#if canImport(UIKit)
import QuartzCore
import UIKit

/// UIKit construction must run on main. Give the navigation shell its first
/// frame, then construct one small part per frame, rather than delaying the
/// push or moving the entire old constructor into its first animation frame.
@MainActor
final class ChatConstruction: NSObject {
    private var link: CADisplayLink?
    private var firstFrame = true
    private var steps: [() -> Void]
    private let isCurrent: () -> Bool
    private(set) var stageSeconds: [CFTimeInterval] = []

    init(steps: [() -> Void], isCurrent: @escaping () -> Bool) {
        self.steps = steps
        self.isCurrent = isCurrent
        super.init()
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    func cancel() {
        link?.invalidate()
        link = nil
        steps.removeAll()
    }

    @objc private func tick() {
        guard isCurrent() else { cancel(); return }
        // The first callback precedes the shell's first presentation.
        if firstFrame { firstFrame = false; return }
        guard !steps.isEmpty else { cancel(); return }
        let step = steps.removeFirst()
        let started = CACurrentMediaTime()
        step()
        stageSeconds.append(CACurrentMediaTime() - started)
        if steps.isEmpty { cancel() }
    }
}
#endif
