import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Where a session avatar's harness badge goes (components/Avatar.tsx). A
/// session without a picture wears its `AvatarPlaceholder`, not happy-app's
/// generated faces.
public enum AvatarBadge {
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
