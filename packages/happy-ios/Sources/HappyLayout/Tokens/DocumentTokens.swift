import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// A document Surface as desktop's editor draws it (BlockNote 0.51's
// default theme in happy-desktop-ui `DocumentEditor`, `styles/document-surface.css`),
// set for a phone's reading width.

extension Palette {
    /// The text (`--text`) and what is said beside it: a marker, a save state (`--text-secondary`).
    public static let documentText = ColorToken("#000000", "#ffffff")
    public static let documentSecondary = ColorToken("#6b6b6b", "#a0a0a0")
    /// The page.
    public static let documentGround = ColorToken("#ffffff", "#1f1f1f")
    /// A link (BlockNote's `a`).
    public static let documentLink = ColorToken("#1a7f99", "#5cc8e2")
    /// Inline code's and a code block's fill.
    public static let documentCodeFill = ColorToken("#f3f3f1", "#2a2a2a")
    public static let documentCodeText = ColorToken("#c7254e", "#ff8fa8")
    /// A quote's bar, a divider's line, an open task's box.
    public static let documentRule = ColorToken("#d9d9d9", "#3d3d3d")
    /// A done task's box, and its tick.
    public static let documentCheck = ColorToken("#1a7f99", "#5cc8e2")
    public static let documentCheckTick = ColorToken("#ffffff", "#1f1f1f")
    /// A done task's text.
    public static let documentDone = ColorToken("#9a9a9a", "#7a7a7a")
    /// The formatting bar's glyph, and a lit one's.
    public static let documentTool = ColorToken("#000000", "#ffffff")
    public static let documentToolActive = ColorToken("#1a7f99", "#5cc8e2")
    public static let documentToolActiveFill = ColorToken(light: RGBA(red: 0.1, green: 0.5, blue: 0.6, alpha: 0.14), dark: RGBA(red: 0.36, green: 0.78, blue: 0.89, alpha: 0.2))
}

public enum DocumentTokens {
    /// Body text at the default text size; Dynamic Type scales it (`UIFontMetrics(.body)`).
    public static let bodySize: CGFloat = 17
    public static let bodyLineHeight: CGFloat = 26
    public static let codeSize: CGFloat = 15
    /// Heading sizes by level, desktop's ramp brought down to a phone.
    public static func headingSize(_ level: Int) -> CGFloat {
        switch level {
        case 1: 30
        case 2: 24
        case 3: 20
        default: 18
        }
    }
    public static func headingLineHeight(_ level: Int) -> CGFloat { (headingSize(level) * 1.25).rounded() }
    /// Space above a block, and above a heading.
    public static let blockSpacing: CGFloat = 6
    public static let headingSpacing: CGFloat = 14
}
