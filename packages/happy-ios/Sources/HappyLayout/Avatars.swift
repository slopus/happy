import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Generated avatars, picked from a seed exactly as happy-app picks them
/// (components/AvatarBrutalist.tsx, AvatarGradient.tsx, AvatarSkia.tsx), so
/// a session has the same face in both apps.
public enum GeneratedAvatar {
    /// The `hashCode` all three renderers share: Java's string hash over
    /// UTF-16 code units in 32-bit arithmetic, then `Math.abs`, which leaves
    /// Int32.min positive.
    public static func hashCode(_ string: String) -> Int64 {
        var hash: Int32 = 0
        for unit in string.utf16 {
            hash = (hash &<< 5) &- hash &+ Int32(unit)
        }
        return abs(Int64(hash))
    }

    // MARK: Brutalist

    public struct Brutalist: Equatable, Sendable {
        /// A template image in HappyUI's Avatars resources.
        public var imageName: String
        public var tint: RGBA
        public var background: RGBA
    }

    static let abstractCount = 262
    static let bauhausCount = 40
    static let brutalismCount = 118
    public static let brutalistImageCount = abstractCount + bauhausCount + brutalismCount

    static let brutalistColors: [(tint: String, background: String)] = [
        ("#FFA617", "#0056B3"),
        ("#59C9DF", "#DC2626"),
        ("#C678FF", "#16A34A"),
        ("#FF79D7", "#047857"),
        ("#FFD800", "#4C1D95"),
        ("#84E600", "#C026D3"),
    ]

    public static func brutalist(seed: String, monochrome: Bool) -> Brutalist {
        let index = Int(hashCode(seed) % Int64(brutalistImageCount))
        let colors = brutalistColors[Int(hashCode(seed + "color") % Int64(brutalistColors.count))]
        return Brutalist(
            imageName: brutalistImageName(index),
            tint: RGBA(hex: monochrome ? "#999999" : colors.tint) ?? .black,
            background: RGBA(hex: monochrome ? "#F0F0F0" : colors.background) ?? .black
        )
    }

    /// `allImages` is Abstract 1–262, then Bauhaus 1–40, then Brutalism 1–118.
    public static func brutalistImageName(_ index: Int) -> String {
        if index < abstractCount { return "Abstract-\(index + 1)" }
        if index < abstractCount + bauhausCount { return "Bauhaus-\(index - abstractCount + 1)" }
        return "Brutalism-\(index - abstractCount - bauhausCount + 1)"
    }

    /// The brutalist glyph is 80% of the disc.
    public static let brutalistImageScale: CGFloat = 0.8

    // MARK: Gradient

    public static let gradientImageCount = 100

    /// `gradients/01.png` … `100.png`, bundled as `gradient-01` and so on.
    public static func gradientImageName(seed: String) -> String {
        "gradient-" + String(format: "%02d", Int(hashCode(seed) % Int64(gradientImageCount)) + 1)
    }

    // MARK: Pixelated

    public static let pixelGridSize = 8
    static let pixelColors = ["#0a0310", "#49007e", "#ff005b", "#ff7d10", "#ffb238"]
    static let pixelGrays = ["#070707", "#242424", "#575757", "#979797", "#bbbbbb"]

    /// 64 cells, row by row: cell `i` takes palette entry `hash % (i + 1)`.
    public static func pixels(seed: String, monochrome: Bool) -> [RGBA] {
        let hash = hashCode(seed)
        let palette = (monochrome ? pixelGrays : pixelColors).map { RGBA(hex: $0) ?? .black }
        return (0..<(pixelGridSize * pixelGridSize)).map { index in
            palette[Int((hash % Int64(index + 1)) % Int64(palette.count))]
        }
    }

    /// The 64 cells, row by row, in an avatar `size` across.
    public static func pixelFrames(size: CGFloat) -> [CGRect] {
        let cell = size / CGFloat(pixelGridSize)
        return (0..<(pixelGridSize * pixelGridSize)).map { index in
            CGRect(x: CGFloat(index % pixelGridSize) * cell, y: CGFloat(index / pixelGridSize) * cell, width: cell, height: cell)
        }
    }

    // MARK: Glyphs

    /// The brutalist image, 80% of the disc, centred.
    public static func brutalistGlyphFrame(avatarSize size: CGFloat) -> CGRect {
        centredSquare(size * brutalistImageScale, in: size)
    }

    /// Avatar.tsx: a bot without a picture shows a chip, its icon size
    /// rounded to whole points as Ionicons takes it.
    public static func botGlyphFrame(avatarSize size: CGFloat) -> CGRect {
        centredSquare((size * 0.55).rounded(), in: size)
    }

    private static func centredSquare(_ side: CGFloat, in size: CGFloat) -> CGRect {
        CGRect(x: (size - side) / 2, y: (size - side) / 2, width: side, height: side)
    }

    // MARK: Badge

    /// `harnessBadgeSizes`: each harness mark keeps clear air inside the
    /// circle. Happy Agent's square "H" needs the most.
    public static func badgeGlyphRatio(harness: String) -> CGFloat {
        switch harness {
        case "rig": 0.26
        case "codex": 0.3
        case "claude": 0.34
        default: 0.42
        }
    }

    /// Avatar.tsx `harnessBadgeSizes`: the circle in the bottom-right corner
    /// that names the harness, and the glyph inside it.
    public static func badge(avatarSize size: CGFloat, glyphRatio: CGFloat) -> (circle: CGRect, glyph: CGRect) {
        let circle = (size * 0.42).rounded()
        let glyph = (size * glyphRatio).rounded()
        // bottom: -2, right: -2
        let frame = CGRect(x: size + 2 - circle, y: size + 2 - circle, width: circle, height: circle)
        return (frame, CGRect(x: frame.midX - glyph / 2, y: frame.midY - glyph / 2, width: glyph, height: glyph))
    }
}
