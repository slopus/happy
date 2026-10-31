import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Rich tasks: the "Sidebar sub-rows" proposal with corner B, measured from
// it as Happy's stylesheet and Figtree draw it (task_174 mock v3).

extension Palette {
    /// Happy's stylesheet colours (`--happy-text`, `-muted`, `-accent`, `-added`, `-removed`).
    public static let taskText = ColorToken("#18171a", "#f4f3f6")
    public static let taskMuted = ColorToken("#5c5862", "#b9b4c0")
    public static let taskAccent = ColorToken("#1683a3", "#3cb9d8")
    public static let taskAdded = ColorToken("#1a7f37", "#4ac26b")
    public static let taskRemoved = ColorToken("#cf222e", "#f47067")
}

public enum TaskListMetrics {
    /// The list's room above its first row and below its last.
    public static let top: CGFloat = 4
    public static let bottom: CGFloat = 10
    /// Every row's box is this far in from the list's sides.
    public static let inset: CGFloat = 3
    /// A highlight is painted this far inside its row, top and bottom, so two lit rows stand 4 apart.
    public static let highlightInset: CGFloat = 2
    /// Selected: the accent at 10%; pressed: the ink at 4%.
    public static let selectedAlpha: CGFloat = 0.1
    public static let pressedAlpha: CGFloat = 0.04

    /// The card: 68 tall, its highlight 64 and rounded 14.
    public static let cardHeight: CGFloat = 68
    public static let cardRadius: CGFloat = 14
    /// The disc 7 into the highlight and centred on it; its fill the ink at 5%.
    public static let pad: CGFloat = 7
    public static let disc: CGFloat = 50
    public static let discInk: CGFloat = 0.05
    /// The icon in it, smaller inside a story's ring: the ring 2 wide on the
    /// disc's edge, the fill from 4 in (`.disc.ring`'s padding).
    public static let icon: CGFloat = 40
    public static let storyIcon: CGFloat = 34
    public static let storyRing: CGFloat = 2
    public static let storyFill: CGFloat = 4
    /// Disc to text; the title's line and the time 8 apart.
    public static let textGap: CGFloat = 10
    public static let timeGap: CGFloat = 8
    /// The title's line (20), then the status's two 16 lines, 0.5 up into it.
    public static let titleLine: CGFloat = 20
    public static let statusLine: CGFloat = 16
    public static let statusOverlap: CGFloat = 0.5
    /// The status's first line ends this far inside the highlight; the second one 6 before the corner.
    public static let statusEnd: CGFloat = 12
    public static let cornerGap: CGFloat = 6
    /// Corner B: every item 14 tall, centred on the last status line's x-height, 6 apart.
    public static let chip: CGFloat = 14
    /// Each face over the one before by 30%, ringed 1.5 in the ground.
    public static let faceStep: CGFloat = chip * 0.7
    public static let faceRing: CGFloat = 1.5
    public static let faces = 3
    /// The braille's 2×4 dots of 2, 2 apart.
    public static let brailleWidth: CGFloat = 6

    /// A sub-row: 30 tall, its highlight from 35 in, rounded 8; the 18 mark
    /// ends where the disc does, the text starts where the card's does.
    public static let subRowHeight: CGFloat = 30
    public static let subRowRadius: CGFloat = 8
    public static let subRowHighlight: CGFloat = 35
    public static let mark: CGFloat = 18
    public static let markRadius: CGFloat = 5
    public static let pictureRadius: CGFloat = 4.5
    public static let markInk: CGFloat = 0.06
    public static let markGlyph: CGFloat = 12
    /// Text on a 24 line centred in its row; the trail 8 after the text, its items 6 apart.
    public static let rowLine: CGFloat = 24
    public static let trailGap: CGFloat = 8
    public static let dimmed: CGFloat = 0.5

    /// "+N more" under the sub-rows: 24 tall, its text where the card's starts.
    public static let moreHeight: CGFloat = 24

    /// A section header: 28 tall, 8 below what is over it (2 when folded), its title 14 in, its fold in a 12 box ending 14 in.
    public static let headerHeight: CGFloat = 28
    public static let headerGap: CGFloat = 8
    public static let foldedHeaderGap: CGFloat = 2
    public static let headerInset: CGFloat = 14
    public static let headerTracking: CGFloat = 0.12
    public static let chevron: CGFloat = 12

    /// Type sizes: title 15.5 semibold, time 12.5, status 14, sub-row 13,
    /// "more" 12.5 semibold, header 11.5 semibold.
    public static let titleSize: CGFloat = 15.5
    public static let timeSize: CGFloat = 12.5
    public static let statusSize: CGFloat = 14
    public static let subRowSize: CGFloat = 13
    public static let moreSize: CGFloat = 12.5
    public static let headerSize: CGFloat = 11.5
}
