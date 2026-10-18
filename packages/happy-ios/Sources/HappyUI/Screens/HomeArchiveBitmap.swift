#if canImport(UIKit)
import UIKit
import UltraView

/// CGImage is immutable. A prepared archive viewport owns these images only
/// for its current account/model/width/text/theme generation.
struct HomeArchiveBitmap: @unchecked Sendable {
    let image: CGImage
    let scale: CGFloat

    nonisolated static func draw(_ plan: HomeRowDrawing) -> HomeArchiveBitmap? {
        #if DEBUG || HAPPY_FIXTURES
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        guard plan.size.width > 0, plan.size.height > 0 else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = plan.environment.text.displayScale; format.opaque = false
        let image = UIGraphicsImageRenderer(size: plan.size, format: format).image { plan.draw(in: $0.cgContext) }
        return image.cgImage.map { HomeArchiveBitmap(image: $0, scale: format.scale) }
    }
}

/// Fixed-height archive rows can mount in the tap's transaction. A prepared
/// bitmap is assigned immediately; a cache miss draws off main only after
/// mounting, and is never reported as ready merely because its avatar exists.
@MainActor
final class HomeArchiveBitmapView: ListRowView {
    private var plan: HomeRowDrawing
    private var ready = false
    private var generation: UInt64 = 0
    private var render: Task<Void, Never>?
    override var isDisplayReady: Bool { ready }

    init(plan: HomeRowDrawing, bitmap: HomeArchiveBitmap?) {
        self.plan = plan
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        apply(plan: plan, bitmap: bitmap)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func apply(plan: HomeRowDrawing, bitmap: HomeArchiveBitmap?) {
        generation += 1; render?.cancel(); render = nil
        self.plan = plan; ready = false
        if let bitmap { show(bitmap) }
        else { layer.contents = nil; drawIfVisible() }
    }

    override func didMoveToWindow() { super.didMoveToWindow(); drawIfVisible() }

    private func drawIfVisible() {
        guard window != nil, !ready, render == nil else { return }
        let plan = plan, generation = generation
        render = Task { [weak self] in
            let bitmap = await Task.detached(priority: .userInitiated) { HomeArchiveBitmap.draw(plan) }.value
            guard !Task.isCancelled, let self, self.generation == generation else { return }
            self.render = nil
            if let bitmap { self.show(bitmap) }
        }
    }

    private func show(_ bitmap: HomeArchiveBitmap) {
        CATransaction.begin(); CATransaction.setDisableActions(true)
        layer.contentsScale = bitmap.scale
        layer.contents = bitmap.image
        CATransaction.commit()
        ready = true; reportDisplayReady()
    }
}
#endif
