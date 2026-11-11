/*
 * The fragment shader below is ported from Paper's Liquid Metal
 * (https://github.com/paper-design/shaders, packages/shaders/src/shaders/
 * liquid-metal.ts at e7003a2, @paper-design/shaders 0.0.82, with
 * simplexNoise, rotation2 and colorBandingFix from shader-utils.ts and the
 * image sizing from vertex-shader.ts). Its mask preprocessing
 * (toProcessedLiquidMetal, in the same file) is run ahead of time by
 * scripts/liquid-metal/cloud.py, which wrote Resources/LiquidMetal.
 *
 * Its NOTICE file reads:
 *
 *     Powered by Paper Shaders:
 *     https://shaders.paper.design
 *
 * Paper Shaders is licensed under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance with the
 * License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 *
 * Changes from the original: GLSL ES 3.0 to Metal; only an image mask, with
 * Paper's default preset (fit contain, scale 1, no rotation or offset,
 * speed 1, repetition 2, softness 0.1, shiftRed 0.3, shiftBlue 0.3,
 * distortion 0.07, contour 0.4, angle 70) fixed in the source and a
 * transparent background; the mask's edge field, which never moves,
 * worked out once, ahead of time, blurred and raised to 1.6 as
 * blurEdge3x3 and the line after it do, so a frame reads it once rather
 * than nine times; the banding dither scaled by the mark's opacity, so the
 * transparent square around it stays transparent.
 */
#if canImport(UIKit)
import Metal
import QuartzCore
import UIKit

/// A mark in Paper's Liquid Metal: chrome stripes that flow over it,
/// bending at its edges. It fills the view's square (a wider or taller view
/// centres it) and nothing around it is drawn, so it sits on any
/// background.
///
/// It moves at Paper's default speed, at the display's rate (120 frames a
/// second on ProMotion, 60 elsewhere), while on screen and the app is
/// active, and holds still with Reduce Motion (on Paper's frame 0). As
/// `GrainGradientView` does, frames are encoded and presented off the main
/// thread, a frame still on its way when the next is due is skipped, and
/// one asked for by a resize or a new tint is drawn once it lands. Without
/// Metal the mark stands still in `fallbackColor`.
///
/// Only the view's own pixels are drawn, and the mask's edge field comes
/// baked, so a frame is one texture read and the stripes' arithmetic per
/// pixel. `HAPPY_LIQUID_METAL_PROBE=1` prints each frame's GPU time.
final class LiquidMetalView: UIView {
    /// What is drawn in metal: a mask and its edge field, baked by
    /// scripts/liquid-metal/cloud.py.
    enum Mark: String, Sendable {
        /// The Happy Cloud mark: a cloud with the Happy "H" cut out of it.
        case cloud = "cloud-liquid-metal"
    }

    /// Colour-burned over the chrome, as Paper's `colorTint`; white
    /// changes nothing. May be dynamic.
    var tint: UIColor = .white {
        didSet { if tint != oldValue { render() } }
    }

    /// Held still where it is, as a slide scrolled out of view is; it
    /// stops by itself off screen, in the background and with Reduce Motion.
    var isPaused = false {
        didSet { if isPaused != oldValue { updateLink() } }
    }

    /// The mark's colour where Metal is missing.
    var fallbackColor: UIColor = .systemGray {
        didSet { fallback?.backgroundColor = fallbackColor.resolvedColor(with: traitCollection).cgColor }
    }

    let mark: Mark
    private let renderer = LiquidMetalRenderer.shared
    private var link: CADisplayLink?
    private var time: Double = 0
    private var last: CFTimeInterval?
    private var metalLayer: CAMetalLayer? { layer as? CAMetalLayer }
    private var fallback: CALayer?
    private let inFlight = LiquidMetalInFlight()

    override class var layerClass: AnyClass { LiquidMetalRenderer.shared == nil ? CALayer.self : CAMetalLayer.self }

    init(mark: Mark = .cloud) {
        self.mark = mark
        super.init(frame: .zero)
        isOpaque = false
        backgroundColor = .clear
        // The mark says nothing a title beside it doesn't.
        isAccessibilityElement = false
        if let metalLayer, let renderer {
            metalLayer.device = renderer.device
            metalLayer.pixelFormat = .bgra8Unorm
            metalLayer.framebufferOnly = true
            metalLayer.isOpaque = false
        } else {
            // The mask's alpha over a flat colour.
            let still = CALayer()
            let shape = CALayer()
            shape.contents = LiquidMetalField.maskImage(mark)
            shape.contentsGravity = .resizeAspect
            still.mask = shape
            layer.addSublayer(still)
            fallback = still
        }
        let center = NotificationCenter.default
        for name in [UIApplication.didBecomeActiveNotification, UIApplication.willResignActiveNotification, UIAccessibility.reduceMotionStatusDidChangeNotification] {
            center.addObserver(self, selector: #selector(updateLink), name: name, object: nil)
        }
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.render()
            self.fallback?.backgroundColor = self.fallbackColor.resolvedColor(with: self.traitCollection).cgColor
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if let window { metalLayer?.contentsScale = window.screen.scale }
        updateLink()
        render()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if let metalLayer {
            let scale = metalLayer.contentsScale
            let drawable = CGSize(width: (bounds.width * scale).rounded(), height: (bounds.height * scale).rounded())
            if metalLayer.drawableSize != drawable {
                metalLayer.drawableSize = drawable
                render()
            }
        }
        if let fallback {
            fallback.frame = bounds
            fallback.mask?.frame = bounds
            fallback.backgroundColor = fallbackColor.resolvedColor(with: traitCollection).cgColor
        }
    }

    private var moves: Bool {
        window != nil && renderer != nil && !isPaused && !UIAccessibility.isReduceMotionEnabled
            && UIApplication.shared.applicationState != .background
    }

    @objc private func updateLink() {
        guard moves, UIApplication.shared.applicationState == .active else {
            link?.invalidate(); link = nil; last = nil
            if UIAccessibility.isReduceMotionEnabled { time = 0; render() }
            return
        }
        guard link == nil else { return }
        let link = CADisplayLink(target: LiquidMetalTick(self), selector: #selector(LiquidMetalTick.tick(_:)))
        // The screen's own rate: 120 on ProMotion, 60 elsewhere.
        let rate = Float((window?.windowScene?.screen.maximumFramesPerSecond ?? 60) >= 120 ? 120 : 60)
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: rate, preferred: rate)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    fileprivate func tick(_ link: CADisplayLink) {
        // Time stands still while paused; it picks up where it stopped.
        if let last { time += link.timestamp - last }
        last = link.timestamp
        render(skippable: true)
    }

    /// Draws the mark as it stands. A tick's frame is `skippable`: the next
    /// tick draws anyway.
    private func render(skippable: Bool = false) {
        guard let renderer, let metalLayer, metalLayer.drawableSize.width > 0, metalLayer.drawableSize.height > 0 else { return }
        let uniforms = LiquidMetalRenderer.Uniforms(
            resolution: SIMD2(Float(metalLayer.drawableSize.width), Float(metalLayer.drawableSize.height)),
            time: Float(time),
            tint: LiquidMetalRenderer.rgba(tint.resolvedColor(with: traitCollection))
        )
        let target = LiquidMetalTarget(layer: metalLayer)
        guard inFlight.begin(orAfter: !skippable) else { return }
        let inFlight = inFlight, mark = mark
        LiquidMetalRenderer.queue.async { [weak self] in
            renderer.draw(mark, in: target, uniforms: uniforms)
            guard inFlight.end() else { return }
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.render() } }
        }
    }
}

/// The display link's target, so the link doesn't keep the view alive.
private final class LiquidMetalTick: NSObject {
    weak var view: LiquidMetalView?
    init(_ view: LiquidMetalView) { self.view = view }
    @MainActor @objc func tick(_ link: CADisplayLink) {
        guard let view else { return link.invalidate() }
        view.tick(link)
    }
}

/// Whether a view's frame is being drawn; touched from the main thread and
/// the render queue.
private final class LiquidMetalInFlight: @unchecked Sendable {
    private let lock = NSLock()
    private var busy = false
    private var again = false

    /// Takes the slot, unless a frame has it; then, `orAfter`, that frame is
    /// asked to be followed by another.
    func begin(orAfter: Bool) -> Bool {
        lock.withLock {
            if busy { again = again || orAfter; return false }
            busy = true
            return true
        }
    }

    /// Frees the slot; true when a frame was asked for meanwhile.
    func end() -> Bool {
        lock.withLock {
            busy = false
            defer { again = false }
            return again
        }
    }
}

/// A view's Metal layer, handed to the render queue. CAMetalLayer's
/// `nextDrawable` may be called from any thread; its size is set only on
/// the main thread.
private struct LiquidMetalTarget: @unchecked Sendable {
    let layer: CAMetalLayer
}

/// A mark's baked field: 512 square, red the edge (Paper's Poisson field,
/// blurred and raised to 1.6), green the mask's alpha.
private enum LiquidMetalField {
    static func image(_ mark: LiquidMetalView.Mark) -> CGImage? {
        UIImage(named: mark.rawValue, in: .module, compatibleWith: nil)?.cgImage
    }

    /// Red and green of every pixel, rows top first.
    static func bytes(_ mark: LiquidMetalView.Mark) -> (width: Int, height: Int, rg: [UInt8])? {
        guard let image = image(mark) else { return nil }
        let width = image.width, height = image.height
        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        // The PNG is opaque, so premultiplying leaves red and green alone.
        let drawn = rgba.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }
        var rg = [UInt8](repeating: 0, count: width * height * 2)
        for i in 0..<(width * height) {
            rg[i * 2] = rgba[i * 4]
            rg[i * 2 + 1] = rgba[i * 4 + 1]
        }
        return (width, height, rg)
    }

    /// The mask alone, white where the mark is, for the still stand-in.
    @MainActor static func maskImage(_ mark: LiquidMetalView.Mark) -> CGImage? {
        guard let field = bytes(mark) else { return nil }
        var rgba = [UInt8](repeating: 0, count: field.width * field.height * 4)
        for i in 0..<(field.width * field.height) {
            let alpha = field.rg[i * 2 + 1]
            rgba[i * 4] = alpha; rgba[i * 4 + 1] = alpha; rgba[i * 4 + 2] = alpha; rgba[i * 4 + 3] = alpha
        }
        guard let provider = CGDataProvider(data: Data(rgba) as CFData) else { return nil }
        return CGImage(width: field.width, height: field.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: field.width * 4,
                       space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }
}

/// The one pipeline every mark draws with. Its Metal objects are
/// thread-safe and never change; fields are loaded and frames drawn only on
/// `queue`.
private final class LiquidMetalRenderer: @unchecked Sendable {
    static let shared = LiquidMetalRenderer()
    /// Where frames are encoded and presented.
    static let queue = DispatchQueue(label: "happy.liquid-metal", qos: .userInitiated)

    let device: MTLDevice
    private let commands: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private let sampler: MTLSamplerState
    /// Each mark's field, mipmapped, loaded once.
    private var fields: [LiquidMetalView.Mark: MTLTexture] = [:]
    private let probe = ProcessInfo.processInfo.environment["HAPPY_LIQUID_METAL_PROBE"] != nil ? LiquidMetalProbe() : nil

    private init?() {
        guard let device = MTLCreateSystemDefaultDevice(), let commands = device.makeCommandQueue() else { return nil }
        do {
            let library = try device.makeLibrary(source: liquidMetalShader, options: nil)
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = library.makeFunction(name: "liquid_metal_vertex")
            descriptor.fragmentFunction = library.makeFunction(name: "liquid_metal_fragment")
            descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
            pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        } catch {
            // A compiler that refuses the source gets the still mark.
            return nil
        }
        let samplerDescriptor = MTLSamplerDescriptor()
        samplerDescriptor.minFilter = .linear
        samplerDescriptor.magFilter = .linear
        samplerDescriptor.mipFilter = .linear
        samplerDescriptor.sAddressMode = .clampToEdge
        samplerDescriptor.tAddressMode = .clampToEdge
        guard let sampler = device.makeSamplerState(descriptor: samplerDescriptor) else { return nil }
        self.device = device
        self.commands = commands
        self.sampler = sampler
    }

    struct Uniforms {
        var resolution: SIMD2<Float>
        var time: Float
        var pad: Float = 0
        var tint: SIMD4<Float>
    }

    static func rgba(_ color: UIColor) -> SIMD4<Float> {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        return SIMD4(Float(r), Float(g), Float(b), Float(a))
    }

    /// The mark's field, loaded and mipmapped the first time it is asked for.
    @discardableResult
    func prepare(_ mark: LiquidMetalView.Mark) -> MTLTexture? {
        dispatchPrecondition(condition: .onQueue(Self.queue))
        if let texture = fields[mark] { return texture }
        guard let field = LiquidMetalField.bytes(mark) else { return nil }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rg8Unorm, width: field.width, height: field.height, mipmapped: true)
        descriptor.usage = .shaderRead
        guard let texture = device.makeTexture(descriptor: descriptor) else { return nil }
        field.rg.withUnsafeBytes { bytes in
            texture.replace(region: MTLRegionMake2D(0, 0, field.width, field.height), mipmapLevel: 0, withBytes: bytes.baseAddress!, bytesPerRow: field.width * 2)
        }
        if let buffer = commands.makeCommandBuffer(), let blit = buffer.makeBlitCommandEncoder() {
            blit.generateMipmaps(for: texture)
            blit.endEncoding()
            buffer.commit()
        }
        fields[mark] = texture
        return texture
    }

    func draw(_ mark: LiquidMetalView.Mark, in target: LiquidMetalTarget, uniforms: Uniforms) {
        var uniforms = uniforms
        guard let field = prepare(mark), let drawable = target.layer.nextDrawable(), let buffer = commands.makeCommandBuffer() else { return }
        // The drawable's own size: the layer's may have changed since the
        // uniforms were read.
        uniforms.resolution = SIMD2(Float(drawable.texture.width), Float(drawable.texture.height))
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = drawable.texture
        pass.colorAttachments[0].loadAction = .dontCare
        pass.colorAttachments[0].storeAction = .store
        guard let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 0)
        encoder.setFragmentTexture(field, index: 0)
        encoder.setFragmentSamplerState(sampler, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
        if let probe {
            let pixels = drawable.texture.width * drawable.texture.height
            buffer.addCompletedHandler { probe.add($0.gpuEndTime - $0.gpuStartTime, pixels: pixels) }
        }
        buffer.present(drawable)
        buffer.commit()
    }
}

/// With HAPPY_LIQUID_METAL_PROBE set: each frame's GPU time, printed every
/// 240 frames to standard error.
private final class LiquidMetalProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var times: [Double] = []

    func add(_ seconds: Double, pixels: Int) {
        let line: String? = lock.withLock {
            times.append(seconds)
            guard times.count == 240 else { return nil }
            let sorted = times.sorted()
            times.removeAll()
            let mean = sorted.reduce(0, +) / Double(sorted.count)
            return String(format: "liquid-metal gpu %d px: mean %.3f ms, median %.3f ms, p95 %.3f ms, max %.3f ms\n",
                          pixels, mean * 1000, sorted[120] * 1000, sorted[228] * 1000, sorted[239] * 1000)
        }
        if let line { FileHandle.standardError.write(Data(line.utf8)) }
    }
}

/// Paper's liquid-metal.ts fragment shader, image branch, with v_imageUV
/// for fit contain worked out per pixel.
private let liquidMetalShader = """
#include <metal_stdlib>
using namespace metal;

struct Uniforms {
  float2 resolution;
  float time;
  float pad;
  float4 tint;
};

vertex float4 liquid_metal_vertex(uint id [[vertex_id]]) {
  float2 p = float2((id << 1) & 2, id & 2);
  return float4(p * 2.0 - 1.0, 0.0, 1.0);
}

#define PI 3.14159265358979323846

constant float REPETITION = 2.;
constant float SOFTNESS = .1;
constant float SHIFT_RED = .3;
constant float SHIFT_BLUE = .3;
constant float DISTORTION = .07;
constant float CONTOUR = .4;
constant float ANGLE = 70.;

// GLSL's mod: floored, unlike Metal's fmod.
template <typename T> T gmod(T x, float y) { return x - y * floor(x / y); }

float2 rotate(float2 uv, float th) {
  return float2x2(float2(cos(th), sin(th)), float2(-sin(th), cos(th))) * uv;
}

float3 permute(float3 x) { return gmod(((x * 34.0) + 1.0) * x, 289.0); }

float snoise(float2 v) {
  const float4 C = float4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  float2 i = floor(v + dot(v, C.yy));
  float2 x0 = v - i + dot(i, C.xx);
  float2 i1 = (x0.x > x0.y) ? float2(1.0, 0.0) : float2(0.0, 1.0);
  float4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = gmod(i, 289.0);
  float3 p = permute(permute(i.y + float3(0.0, i1.y, 1.0)) + i.x + float3(0.0, i1.x, 1.0));
  float3 m = max(0.5 - float3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  float3 x = 2.0 * fract(p * C.www) - 1.0;
  float3 h = abs(x) - 0.5;
  float3 ox = floor(x + 0.5);
  float3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  float3 g = float3(0.);
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float getColorChanges(float c1, float c2, float stripe_p, float3 w, float blur, float bump, float tint, float tintAlpha) {
  float ch = mix(c2, c1, smoothstep(.0, 2. * blur, stripe_p));

  float border = w[0];
  ch = mix(ch, c2, smoothstep(border, border + 2. * blur, stripe_p));

  bump = smoothstep(.2, .8, bump);
  border = w[0] + .4 * (1. - bump) * w[1];
  ch = mix(ch, c1, smoothstep(border, border + 2. * blur, stripe_p));

  border = w[0] + .5 * (1. - bump) * w[1];
  ch = mix(ch, c2, smoothstep(border, border + 2. * blur, stripe_p));

  border = w[0] + w[1];
  ch = mix(ch, c1, smoothstep(border, border + 2. * blur, stripe_p));

  float gradient_t = (stripe_p - w[0] - w[1]) / w[2];
  float gradient = mix(c1, c2, smoothstep(0., 1., gradient_t));
  ch = mix(ch, gradient, smoothstep(border, border + .5 * blur, stripe_p));

  // Tint color is applied with color burn blending
  ch = mix(ch, 1. - min(1., (1. - ch) / max(tint, 0.0001)), tintAlpha);
  return ch;
}

fragment float4 liquid_metal_fragment(float4 position [[position]], constant Uniforms& u [[buffer(0)]],
                                      texture2d<float> image [[texture(0)]], sampler linear [[sampler(0)]]) {
  const float firstFrameOffset = 2.8;
  float t = .3 * (u.time + firstFrameOffset);

  // v_imageUV for a square image, fit contain, scale 1: the shorter side's
  // square, centred, y down.
  float side = min(u.resolution.x, u.resolution.y);
  float2 uv = (position.xy - .5 * u.resolution) / side + .5;
  float4 img = image.sample(linear, uv);

  float cycleWidth = REPETITION;

  float2 rotatedUV = uv - float2(.5);
  float angle = (-ANGLE + 70.) * PI / 180.;
  float cosA = cos(angle);
  float sinA = sin(angle);
  rotatedUV = float2(rotatedUV.x * cosA - rotatedUV.y * sinA, rotatedUV.x * sinA + rotatedUV.y * cosA) + float2(.5);

  // blurEdge3x3 and pow(edge, 1.6) are baked into the field's red.
  float edge = img.r;
  edge *= mix(0.0, 1.0, smoothstep(0.0, 0.4, CONTOUR));

  // getImgFrame(v_imageUV, 0.): nothing outside the image's square.
  float opacity = img.g * step(0., uv.x) * step(uv.x, 1.) * step(0., uv.y) * step(uv.y, 1.);

  float diagBLtoTR = rotatedUV.x - rotatedUV.y;
  float diagTLtoBR = rotatedUV.x + rotatedUV.y;

  float3 color1 = float3(.98, 0.98, 1.);
  float3 color2 = float3(.1, .1, .1 + .1 * smoothstep(.7, 1.3, diagTLtoBR));

  float2 grad_uv = uv - .5;

  float dist = length(grad_uv + float2(0., .2 * diagBLtoTR));
  grad_uv = rotate(grad_uv, (.25 - .2 * diagBLtoTR) * PI);
  float direction = grad_uv.x;

  float bump = pow(1.8 * dist, 1.2);
  bump = 1. - bump;
  bump *= pow(max(uv.y, 0.), .3);

  float thin_strip_1_ratio = .12 / cycleWidth * (1. - .4 * bump);
  float thin_strip_2_ratio = .07 / cycleWidth * (1. + .4 * bump);
  float wide_strip_ratio = (1. - thin_strip_1_ratio - thin_strip_2_ratio);

  float thin_strip_1_width = cycleWidth * thin_strip_1_ratio;
  float thin_strip_2_width = cycleWidth * thin_strip_2_ratio;

  float noise = snoise(uv - t);

  edge += (1. - edge) * DISTORTION * noise;

  direction += diagBLtoTR;
  direction -= 2. * noise * diagBLtoTR * (smoothstep(0., 1., edge) * (1.0 - smoothstep(0., 1., edge)));
  // u_contour range 2
  direction *= mix(1., 1. - edge, smoothstep(.5, 1., CONTOUR));
  direction -= 1.7 * edge * smoothstep(.5, 1., CONTOUR);
  direction += .2 * pow(CONTOUR, 4.) * (1.0 - smoothstep(0., 1., edge));

  bump *= clamp(pow(max(uv.y, 0.), .1), .3, 1.);
  direction *= (.1 + (1.1 - edge) * bump);

  direction *= (.4 + .6 * (1.0 - smoothstep(.5, 1., edge)));
  direction += .18 * (smoothstep(.1, .2, uv.y) * (1.0 - smoothstep(.2, .4, uv.y)));
  direction += .03 * (smoothstep(.1, .2, 1. - uv.y) * (1.0 - smoothstep(.2, .4, 1. - uv.y)));

  direction *= (.5 + .5 * pow(uv.y, 2.));
  direction *= cycleWidth;
  direction -= t;

  float colorDispersion = (1. - bump);
  colorDispersion = clamp(colorDispersion, 0., 1.);
  float dispersionRed = colorDispersion;
  dispersionRed += .03 * bump * noise;
  dispersionRed += 5. * (smoothstep(-.1, .2, uv.y) * (1.0 - smoothstep(.1, .5, uv.y))) * (smoothstep(.4, .6, bump) * (1.0 - smoothstep(.4, 1., bump)));
  dispersionRed -= diagBLtoTR;

  float dispersionBlue = colorDispersion;
  dispersionBlue *= 1.3;
  dispersionBlue += (smoothstep(0., .4, uv.y) * (1.0 - smoothstep(.1, .8, uv.y))) * (smoothstep(.4, .6, bump) * (1.0 - smoothstep(.4, .8, bump)));
  dispersionBlue -= .2 * edge;

  dispersionRed *= (SHIFT_RED / 20.);
  dispersionBlue *= (SHIFT_BLUE / 20.);

  float softness = 0.05 * SOFTNESS;
  float blur = softness + .5 * smoothstep(1., 10., REPETITION) * smoothstep(.0, 1., edge);
  float smallCanvasT = 1.0 - smoothstep(100., 500., min(u.resolution.x, u.resolution.y));
  blur += smallCanvasT * smoothstep(.0, 1., edge);
  float rExtraBlur = softness * (0.05 + .1 * (SHIFT_RED / 20.) * bump);
  float gExtraBlur = softness * 0.05 / max(0.001, abs(1. - diagBLtoTR));

  float3 w = float3(thin_strip_1_width, thin_strip_2_width, wide_strip_ratio);
  w[1] -= .02 * smoothstep(.0, 1., edge + bump);
  float stripe_r = fract(direction + dispersionRed);
  float r = getColorChanges(color1.r, color2.r, stripe_r, w, blur + fwidth(stripe_r) + rExtraBlur, bump, u.tint.r, u.tint.a);
  float stripe_g = fract(direction);
  float g = getColorChanges(color1.g, color2.g, stripe_g, w, blur + fwidth(stripe_g) + gExtraBlur, bump, u.tint.g, u.tint.a);
  float stripe_b = fract(direction - dispersionBlue);
  float b = getColorChanges(color1.b, color2.b, stripe_b, w, blur + fwidth(stripe_b), bump, u.tint.b, u.tint.a);

  float3 color = float3(r, g, b);
  color *= opacity;

  color += opacity / 256. * (fract(sin(dot(.014 * position.xy, float2(12.9898, 78.233))) * 43758.5453123) - .5);

  return float4(color, opacity);
}
"""
#endif
