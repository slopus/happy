/*
 * The fragment shader below is ported from Paper's Grain Gradient
 * (https://github.com/paper-design/shaders, packages/shaders/src/shaders/
 * grain-gradient.ts, with simplexNoise, rotation2 and proceduralHash21 from
 * shader-utils.ts and the object sizing from vertex-shader.ts), by way of
 * happy-android's AGSL port (ui/start/GrainGradient.kt).
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
 * Changes from the original: GLSL ES 3.0 to Metal; only the "corners"
 * shape, with Paper's defaults (fit contain, scale 1, no rotation or
 * offset, speed 1, softness 0.5, intensity 0.5, noise 0.25, four colours)
 * fixed in the source; the noise texture behind randomR replaced by
 * Paper's proceduralHash21 over the same 100-cell period; fwidth replaced
 * by forward differences of the grain one pixel right and one down, as on
 * Android.
 */
#if canImport(UIKit)
import Metal
import QuartzCore
import UIKit

/// The background colour and the four colours Grain Gradient blends, in
/// Paper's order.
struct GrainPalette: Equatable {
    var back: UIColor
    var colors: [UIColor]
}

/// Paper's Grain Gradient, "corners" shape, filling the view. It moves at
/// Paper's default speed, about 30 frames a second (it moves slowly), while
/// on screen and the app is active, and holds still with Reduce Motion (on
/// Paper's frame 0). Without Metal a still gradient in the same colours
/// stands in.
final class GrainGradientView: UIView {
    var palette: GrainPalette {
        didSet { if palette != oldValue { paletteChanged() } }
    }

    private let renderer = GrainRenderer.shared
    private var link: CADisplayLink?
    private var time: Double = 0
    private var last: CFTimeInterval?
    private var metalLayer: CAMetalLayer? { layer as? CAMetalLayer }
    private var fallback: CALayer?

    override class var layerClass: AnyClass { GrainRenderer.shared == nil ? CALayer.self : CAMetalLayer.self }

    init(palette: GrainPalette) {
        self.palette = palette
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        if let metalLayer, let renderer {
            metalLayer.device = renderer.device
            metalLayer.pixelFormat = .bgra8Unorm
            metalLayer.framebufferOnly = true
            metalLayer.isOpaque = true
        } else {
            let still = CALayer()
            layer.addSublayer(still)
            fallback = still
        }
        let center = NotificationCenter.default
        for name in [UIApplication.didBecomeActiveNotification, UIApplication.willResignActiveNotification, UIAccessibility.reduceMotionStatusDidChangeNotification] {
            center.addObserver(self, selector: #selector(updateLink), name: name, object: nil)
        }
        paletteChanged()
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
            fallback.sublayers?.forEach { $0.frame = bounds }
        }
    }

    private var moves: Bool {
        window != nil && renderer != nil && !UIAccessibility.isReduceMotionEnabled
            && UIApplication.shared.applicationState != .background
    }

    @objc private func updateLink() {
        guard moves, UIApplication.shared.applicationState == .active else {
            link?.invalidate(); link = nil; last = nil
            if UIAccessibility.isReduceMotionEnabled { time = 0; render() }
            return
        }
        guard link == nil else { return }
        let link = CADisplayLink(target: GrainTick(self), selector: #selector(GrainTick.tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 24, maximum: 30, preferred: 30)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    fileprivate func tick(_ link: CADisplayLink) {
        // Time stands still while paused; it picks up where it stopped.
        if let last { time += link.timestamp - last }
        last = link.timestamp
        render()
    }

    private func render() {
        guard let renderer, let metalLayer, metalLayer.drawableSize.width > 0, metalLayer.drawableSize.height > 0 else { return }
        renderer.draw(in: metalLayer, time: Float(time), palette: palette.resolved(for: traitCollection))
    }

    private func paletteChanged() {
        render()
        guard let fallback else { return }
        // The still stand-in: the background with each colour glowing in
        // from a corner, as "corners" does.
        let palette = palette.resolved(for: traitCollection)
        fallback.backgroundColor = palette.back.cgColor
        fallback.sublayers?.forEach { $0.removeFromSuperlayer() }
        let corners = [CGPoint(x: 0, y: 1), CGPoint(x: 1, y: 0), CGPoint(x: 0, y: 0.6), CGPoint(x: 1, y: 0.35)]
        for (color, corner) in zip(palette.colors, corners) {
            let glow = CAGradientLayer()
            glow.type = .radial
            glow.colors = [color.withAlphaComponent(0.7).cgColor, color.withAlphaComponent(0).cgColor]
            glow.startPoint = corner
            glow.endPoint = CGPoint(x: corner.x + 0.9, y: corner.y + 0.9)
            glow.frame = bounds
            fallback.addSublayer(glow)
        }
    }
}

/// The display link's target, so the link doesn't keep the view alive.
private final class GrainTick: NSObject {
    weak var view: GrainGradientView?
    init(_ view: GrainGradientView) { self.view = view }
    @MainActor @objc func tick(_ link: CADisplayLink) {
        guard let view else { return link.invalidate() }
        view.tick(link)
    }
}

private extension GrainPalette {
    func resolved(for traits: UITraitCollection) -> GrainPalette {
        GrainPalette(back: back.resolvedColor(with: traits), colors: colors.map { $0.resolvedColor(with: traits) })
    }
}

/// The one pipeline every gradient draws with, compiled once from source.
@MainActor
private final class GrainRenderer {
    static let shared = GrainRenderer()

    let device: MTLDevice
    private let queue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState

    private init?() {
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { return nil }
        do {
            let library = try device.makeLibrary(source: grainGradientMetal, options: nil)
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = library.makeFunction(name: "grain_vertex")
            descriptor.fragmentFunction = library.makeFunction(name: "grain_fragment")
            descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
            pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        } catch {
            // A compiler that refuses the source gets the still gradient.
            return nil
        }
        self.device = device
        self.queue = queue
    }

    private struct Uniforms {
        var resolution: SIMD2<Float>
        var time: Float
        var pad: Float = 0
        var back: SIMD4<Float>
        var color0: SIMD4<Float>
        var color1: SIMD4<Float>
        var color2: SIMD4<Float>
        var color3: SIMD4<Float>
    }

    func draw(in layer: CAMetalLayer, time: Float, palette: GrainPalette) {
        guard let drawable = layer.nextDrawable(), let buffer = queue.makeCommandBuffer() else { return }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = drawable.texture
        pass.colorAttachments[0].loadAction = .dontCare
        pass.colorAttachments[0].storeAction = .store
        guard let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        func rgba(_ color: UIColor) -> SIMD4<Float> {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            color.getRed(&r, green: &g, blue: &b, alpha: &a)
            return SIMD4(Float(r), Float(g), Float(b), Float(a))
        }
        var uniforms = Uniforms(
            resolution: SIMD2(Float(layer.drawableSize.width), Float(layer.drawableSize.height)),
            time: time,
            back: rgba(palette.back),
            color0: rgba(palette.colors[0]), color1: rgba(palette.colors[1]),
            color2: rgba(palette.colors[2]), color3: rgba(palette.colors[3])
        )
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
        buffer.present(drawable)
        buffer.commit()
    }
}

/// Paper's grain-gradient.ts fragment shader for the "corners" shape (4),
/// with Paper's v_objectUV for fit contain worked out per pixel. Line for
/// line Android's AGSL, in Metal.
private let grainGradientMetal = """
#include <metal_stdlib>
using namespace metal;

struct Uniforms {
  float2 resolution;
  float time;
  float pad;
  float4 back;
  float4 color0;
  float4 color1;
  float4 color2;
  float4 color3;
};

vertex float4 grain_vertex(uint id [[vertex_id]]) {
  float2 p = float2((id << 1) & 2, id & 2);
  return float4(p * 2.0 - 1.0, 0.0, 1.0);
}

constant float COUNT = 4.;
constant float SOFTNESS = .5;
constant float INTENSITY = .5;
constant float NOISE = .25;

// GLSL's mod: floored, unlike Metal's fmod.
template <typename T> T gmod(T x, float y) { return x - y * floor(x / y); }

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

float2 rotate(float2 uv, float th) {
  return float2x2(float2(cos(th), sin(th)), float2(-sin(th), cos(th))) * uv;
}

float hash21(float2 p) {
  p = fract(p * float2(0.3183099, 0.3678794)) + 0.1;
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

// textureRandomizerR: one value per whole cell, repeating every 100 cells.
float randomR(float2 p) {
  return hash21(gmod(floor(p), 100.));
}

float valueNoiseR(float2 st) {
  float2 i = floor(st);
  float2 f = fract(st);
  float a = randomR(i);
  float b = randomR(i + float2(1.0, 0.0));
  float c = randomR(i + float2(0.0, 1.0));
  float d = randomR(i + float2(1.0, 1.0));
  float2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// One channel of fbmR: its four channels never mix, so each is its own sum.
float fbm(float2 n) {
  float amplitude = 0.2;
  float total = 0.;
  for (int i = 0; i < 3; i++) {
    n = rotate(n, 0.3);
    total += valueNoiseR(n) * amplitude;
    n *= 1.99;
    amplitude *= 0.6;
  }
  return total;
}

// What the grain adds to the shape at g. fbmR's x, y and the first half of
// its z change too slowly to differ between neighbouring pixels, so they
// come in worked out once ([slow]); fbmR's w is never written, so 0.
float grain(float2 g, float3 slow) {
  float baseNoise = snoise(g * .5);
  float grainDist = baseNoise * snoise(g * .2) - slow.x - slow.y;
  float rawNoise = .75 * baseNoise - (slow.z + fbm(rotate(.4 * g, 2.)));
  float noise = clamp(rawNoise, 0., 1.);
  return INTENSITY * 2. / COUNT * (grainDist + .5) + NOISE * 10. / COUNT * noise;
}

float band(float mixer, float aa) {
  return smoothstep(.5 - .5 * SOFTNESS - aa, .5 + .5 * SOFTNESS + aa, clamp(mixer, 0., 1.));
}

fragment float4 grain_fragment(float4 position [[position]], constant Uniforms& u [[buffer(0)]]) {
  float2 fragCoord = position.xy;
  float t = .1 * (u.time + 7.);

  // v_objectUV for fit contain: a square box the size of the shorter side,
  // centred, y up.
  float box = min(u.resolution.x, u.resolution.y);
  float2 uv = fragCoord / u.resolution - .5;
  uv.y = -uv.y;
  float2 shape_uv = uv * u.resolution / box;
  float2 grain_uv = shape_uv * box * .7;

  // Corners
  shape_uv *= .6;
  float2 outer = float2(.5);
  float2 bl = smoothstep(float2(0.), outer, shape_uv + float2(.1 + .1 * sin(3. * t), .2 - .1 * sin(5.25 * t)));
  float2 tr = smoothstep(float2(0.), outer, 1. - shape_uv);
  float shape = 1. - bl.x * bl.y * tr.x * tr.y;
  shape_uv = -shape_uv;
  bl = smoothstep(float2(0.), outer, shape_uv + float2(.1 + .1 * sin(3. * t), .2 - .1 * cos(5.25 * t)));
  tr = smoothstep(float2(0.), outer, 1. - shape_uv);
  shape -= bl.x * bl.y * tr.x * tr.y;
  shape = 1. - smoothstep(0., 1., shape);

  float3 slow = float3(fbm(.002 * grain_uv + 10.), fbm(.003 * grain_uv), fbm(.001 * grain_uv));
  float added = grain(grain_uv, slow);
  shape += added;

  // fwidth(shape): the grain one pixel right and one pixel down (y is up
  // in grain_uv); the corners themselves barely change over a pixel.
  float aa = abs(grain(grain_uv + float2(.7, 0.), slow) - added) + abs(grain(grain_uv - float2(0., .7), slow) - added);

  shape = clamp(shape - .5 / COUNT, 0., 1.);
  float totalShape = smoothstep(0., SOFTNESS + 2. * aa, clamp(shape * COUNT, 0., 1.));
  float mixer = shape * (COUNT - 1.);

  float4 gradient = u.color0;
  gradient = mix(gradient, u.color1, band(mixer, aa));
  gradient = mix(gradient, u.color2, band(mixer - 1., aa));
  gradient = mix(gradient, u.color3, band(mixer - 2., aa));

  float3 color = gradient.rgb * totalShape + u.back.rgb * (1. - totalShape);
  return float4(color, 1.);
}
"""
#endif
