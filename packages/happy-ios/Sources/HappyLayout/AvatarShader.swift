/// The placeholders as live shaders: what @craftedstudios/shaders draws each
/// one with (`AvatarShaderTable.swift`, made from its own code), and the
/// clock. At its phase a placeholder's shader draws the picture it was
/// made from, so the first live one starts where the still one is.
public enum AvatarShader {
    /// The shader's branch for each effect (renderer.js `FX`).
    public enum Effect: Int, Sendable, CaseIterable {
        case linear = 0
        case thermal = 1
        case topography = 2
        case plasma = 3
        case radial = 4
    }

    public struct Parameters: Equatable, Sendable {
        public var effect: Effect
        /// The effect's colours in its own roles, sRGB 0...1; topography
        /// uses the first three.
        public var colors: [SIMD3<Float>]
        /// Where in its pattern the seed sits: offset (x, y), turn, zoom.
        public var layout: SIMD4<Float>
        /// The direction of the effects that have one, in radians.
        public var angle: Float
        /// Seconds added to the clock, so no two move in step.
        public var phase: Float
    }

    /// The package's defaults, the same for every avatar: distortion 0.5
    /// (warp 1), scale 1, grain 0.07, speed 1.
    public static let warp: Float = 1
    public static let scale: Float = 1
    public static let grain: Float = 0.07

    /// How fast a live placeholder moves: its clock's rate, 1 the
    /// package's own, at which a row's avatar reads as still. Every size
    /// runs at the same rate, so a row, its chat's mark and Settings' large
    /// picture of the same seed show the same frame.
    public static let speed: Float = 2

    /// When each placeholder's clock started: the first time any view asked
    /// for it. Every view of a placeholder reads the one clock, so a row
    /// drawn again, a screen opened from it or come back to, or a view
    /// reused for it shows the frame the others show, never its phase again.
    public struct Clock: Sendable {
        private var origins: [Int: Double] = [:]

        public init() {}

        /// Placeholder `index`'s origin, `now` if nothing has asked yet.
        public mutating func origin(_ index: Int, now: Double) -> Double {
            if let origin = origins[index] { return origin }
            origins[index] = now
            return now
        }

        /// Seconds placeholder `index`'s clock has run at `now`.
        public mutating func elapsed(_ index: Int, now: Double) -> Double {
            max(0, now - origin(index, now: now))
        }
    }

    /// The frames a second live placeholders are drawn at. 30 looks the
    /// same at these speeds and costs the render server about a quarter
    /// more (docs/PERF-GYM.md).
    public static let framesPerSecond: Float = 20

    /// The parameters of placeholder `index` (as `AvatarPlaceholder`).
    public static func parameters(_ index: Int) -> Parameters {
        table[index]
    }

    /// The one `seed` wears: the same placeholder as its still picture.
    public static func parameters(seed: String) -> Parameters {
        table[AvatarPlaceholder.index(seed: seed)]
    }

    /// The shader's clock after `elapsed` seconds on screen.
    public static func time(_ parameters: Parameters, elapsed: Double) -> Float {
        parameters.phase + Float(elapsed)
    }

    /// The grain's cell in device pixels for an avatar `pixels` across
    /// (renderer.js: `max(1, 2r / 540)`), so large ones keep visible grain.
    public static func grainCell(pixels: Int) -> Float {
        max(1, Float(pixels) / 540)
    }
}
