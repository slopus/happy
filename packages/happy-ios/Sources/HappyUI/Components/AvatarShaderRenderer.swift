#if canImport(UIKit)
import HappyLayout
import Metal
import QuartzCore
import UIKit

/// Settings › Appearance › Animated Avatars: the placeholders drawn as the
/// shaders they were made from, moving, instead of their still pictures.
/// Kept on this phone for every account; off unless turned on. Real pictures
/// are never covered.
@MainActor
public enum LiveAvatars {
    static let key = "live-avatars"

    public static var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: key) }
        set {
            guard newValue != isEnabled else { return }
            UserDefaults.standard.set(newValue, forKey: key)
            for slot in slots.allObjects { (slot as? AvatarPlaceholderSlot)?.updateLive() }
        }
    }

    /// Every slot that may wear a live placeholder, so turning it on or off
    /// reaches the ones already on screen.
    static let slots = NSHashTable<AnyObject>.weakObjects()
}

/// One placeholder as its live shader, filling the view it is put in (which
/// clips it). Hidden until its first frame, so the still picture under it
/// shows until then; that frame is the still picture's own, at its phase.
final class LiveAvatarView: UIView {
    override class var layerClass: AnyClass { CAMetalLayer.self }
    var metalLayer: CAMetalLayer { layer as! CAMetalLayer }

    private(set) var index = 0
    private(set) var monochrome = false
    /// When this placeholder first showed; its clock runs from there.
    private(set) var started = CACurrentMediaTime()
    /// A frame of the current placeholder is on screen.
    var drawn = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isHidden = true
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        metalLayer.pixelFormat = .bgra8Unorm
        metalLayer.framebufferOnly = true
        metalLayer.isOpaque = false
        // Presented with the frame's transaction, so a reused cell never
        // shows its last avatar under a new one.
        metalLayer.presentsWithTransaction = true
        if let device = AvatarShaderRenderer.shared?.device { metalLayer.device = device }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(index: Int, monochrome: Bool) {
        guard index != self.index || monochrome != self.monochrome || !drawn else { return }
        let restart = index != self.index
        self.index = index
        self.monochrome = monochrome
        if restart { started = CACurrentMediaTime() }
        drawn = false
        isHidden = true
        AvatarShaderRenderer.shared?.wake()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { AvatarShaderRenderer.shared?.add(self) } else { AvatarShaderRenderer.shared?.remove(self) }
    }
}

/// The one pipeline every live placeholder draws with, compiled off the main
/// thread from `avatarShaderMetal`, and the display link that draws the ones
/// on screen: about 20 frames a second, as the package does (they drift
/// slowly), at most 32 at once, largest first. With Reduce Motion or Low
/// Power Mode each holds one frame. Nil without Metal.
@MainActor
final class AvatarShaderRenderer {
    static let shared = AvatarShaderRenderer()
    static let maxLive = 32
    /// The most pixels across a placeholder is drawn at.
    static let maxPixels = 512

    let device: MTLDevice
    private let queue: MTLCommandQueue
    private var pipeline: MTLRenderPipelineState?
    private var compiling: Task<MTLRenderPipelineState?, Never>?
    private let views = NSHashTable<LiveAvatarView>.weakObjects()
    private var link: CADisplayLink?
    /// Frames put on screen so far, for tests.
    private(set) var presented = 0

    private init?() {
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { return nil }
        self.device = device
        self.queue = queue
        // Turning Reduce Motion or Low Power Mode on or off draws each
        // again, still or moving.
        for name in [UIAccessibility.reduceMotionStatusDidChangeNotification, Notification.Name.NSProcessInfoPowerStateDidChange] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { AvatarShaderRenderer.shared?.redrawAll() }
            }
        }
    }

    /// Whether they move: not with Reduce Motion or in Low Power Mode.
    static var animates: Bool {
        !UIAccessibility.isReduceMotionEnabled && !ProcessInfo.processInfo.isLowPowerModeEnabled
    }

    func add(_ view: LiveAvatarView) {
        views.add(view)
        wake()
    }

    func remove(_ view: LiveAvatarView) {
        views.remove(view)
    }

    /// Compiles the pipeline if it isn't, and runs the link while any
    /// placeholder is in a window.
    func wake() {
        guard views.count > 0 else { return }
        if pipeline == nil {
            compile()
            return
        }
        guard link == nil else { return }
        let link = CADisplayLink(target: Tick(self), selector: #selector(Tick.tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 10, maximum: 30, preferred: 20)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    /// The pipeline, ready; compiled off the main thread on first use.
    func ready() async -> MTLRenderPipelineState? {
        if let pipeline { return pipeline }
        compile()
        let made = await compiling?.value
        return made
    }

    private func compile() {
        guard compiling == nil else { return }
        let device = device
        compiling = Task.detached(priority: .userInitiated) { Self.makePipeline(device) }
        Task { [weak self] in
            let made = await self?.compiling?.value
            guard let self, let made else { return }
            pipeline = made
            wake()
        }
    }

    private nonisolated static func makePipeline(_ device: MTLDevice) -> MTLRenderPipelineState? {
        let options = MTLCompileOptions()
        options.mathMode = .safe
        options.mathFloatingPointFunctions = .precise
        guard let library = try? device.makeLibrary(source: avatarShaderMetal, options: options) else { return nil }
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = library.makeFunction(name: "avatar_vertex")
        descriptor.fragmentFunction = library.makeFunction(name: "avatar_fragment")
        descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
        return try? device.makeRenderPipelineState(descriptor: descriptor)
    }

    private func redrawAll() {
        for view in views.allObjects { view.drawn = false }
    }

    fileprivate func tick() {
        let all = views.allObjects
        guard !all.isEmpty else {
            link?.invalidate()
            link = nil
            return
        }
        guard let pipeline else { return }
        let animates = Self.animates
        let now = CACurrentMediaTime()
        // Past the cap the largest keep moving; the rest show their pictures.
        let showing = all.filter(Self.isShowing).sorted { $0.bounds.width > $1.bounds.width }
        let live = showing.prefix(Self.maxLive)
        for view in showing.dropFirst(Self.maxLive) where view.drawn {
            view.drawn = false
            view.isHidden = true
        }
        let due = live.filter { animates || !$0.drawn }
        guard !due.isEmpty, let buffer = queue.makeCommandBuffer() else { return }
        var drawables: [(LiveAvatarView, CAMetalDrawable)] = []
        for view in due {
            let scale = min(view.window?.screen.scale ?? 3, 3)
            let pixels = min(Self.maxPixels, max(1, Int((view.bounds.width * scale).rounded(.up))))
            let size = CGSize(width: pixels, height: pixels)
            if view.metalLayer.drawableSize != size { view.metalLayer.drawableSize = size }
            guard let drawable = view.metalLayer.nextDrawable() else { continue }
            let parameters = AvatarShader.parameters(view.index)
            let time = animates ? AvatarShader.time(parameters, elapsed: now - view.started) : parameters.phase
            Self.encode(buffer, pipeline: pipeline, into: drawable.texture, parameters: parameters, time: time, pixels: pixels, monochrome: view.monochrome)
            drawables.append((view, drawable))
        }
        guard !drawables.isEmpty else { return }
        buffer.commit()
        buffer.waitUntilScheduled()
        for (view, drawable) in drawables {
            drawable.present()
            presented += 1
            view.drawn = true
            view.isHidden = false
        }
    }

    /// In a window, its size known, and nothing above it hidden or faded out.
    private static func isShowing(_ view: LiveAvatarView) -> Bool {
        guard let window = view.window, !window.isHidden, view.bounds.width > 0 else { return false }
        var ancestor = view.superview
        while let current = ancestor {
            if current.isHidden || current.alpha < 0.01 { return false }
            ancestor = current.superview
        }
        return view.convert(view.bounds, to: window).intersects(window.bounds)
    }

    private struct Uniforms {
        var col1, col2, col3, col4: SIMD4<Float>
        var layout: SIMD4<Float>
        var fx: Float
        var t: Float
        var angle: Float
        var warp: Float
        var scale: Float
        var grain: Float
        var grainCell: Float
        var mono: Float
        var size: SIMD2<Float>
        var pad = SIMD2<Float>(0, 0)
    }

    private static func encode(_ buffer: MTLCommandBuffer, pipeline: MTLRenderPipelineState, into texture: MTLTexture, parameters: AvatarShader.Parameters, time: Float, pixels: Int, monochrome: Bool) {
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = texture
        pass.colorAttachments[0].loadAction = .dontCare
        pass.colorAttachments[0].storeAction = .store
        guard let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        func color(_ index: Int) -> SIMD4<Float> {
            let c = index < parameters.colors.count ? parameters.colors[index] : .zero
            return SIMD4(c, 1)
        }
        var uniforms = Uniforms(
            col1: color(0), col2: color(1), col3: color(2), col4: color(3),
            layout: parameters.layout,
            fx: Float(parameters.effect.rawValue),
            t: time,
            angle: parameters.angle,
            warp: AvatarShader.warp,
            scale: AvatarShader.scale,
            grain: AvatarShader.grain,
            grainCell: AvatarShader.grainCell(pixels: pixels),
            mono: monochrome ? 1 : 0,
            size: SIMD2(Float(pixels), Float(pixels))
        )
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
    }

    /// One frame of placeholder `index` at `time` (its phase when nil),
    /// `pixels` across, read back: for tests and comparisons.
    func image(index: Int, pixels: Int, time: Float? = nil, monochrome: Bool = false) async -> CGImage? {
        guard let pipeline = await ready() else { return nil }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: pixels, height: pixels, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderRead]
        descriptor.storageMode = .shared
        guard let texture = device.makeTexture(descriptor: descriptor), let buffer = queue.makeCommandBuffer() else { return nil }
        let parameters = AvatarShader.parameters(index)
        Self.encode(buffer, pipeline: pipeline, into: texture, parameters: parameters, time: time ?? parameters.phase, pixels: pixels, monochrome: monochrome)
        await withCheckedContinuation { continuation in
            buffer.addCompletedHandler { _ in continuation.resume() }
            buffer.commit()
        }
        let bytesPerRow = pixels * 4
        var bytes = [UInt8](repeating: 0, count: bytesPerRow * pixels)
        texture.getBytes(&bytes, bytesPerRow: bytesPerRow, from: MTLRegionMake2D(0, 0, pixels, pixels), mipmapLevel: 0)
        let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        guard let provider = CGDataProvider(data: Data(bytes) as CFData) else { return nil }
        return CGImage(width: pixels, height: pixels, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: bytesPerRow, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: info, provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }
}

/// The display link's target, so the link doesn't keep the renderer alive.
private final class Tick: NSObject {
    weak var renderer: AvatarShaderRenderer?
    init(_ renderer: AvatarShaderRenderer) { self.renderer = renderer }
    @MainActor @objc func tick(_ link: CADisplayLink) {
        guard let renderer else { return link.invalidate() }
        renderer.tick()
    }
}
#endif
