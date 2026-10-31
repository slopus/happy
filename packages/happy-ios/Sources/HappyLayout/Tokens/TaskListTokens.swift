import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Rich tasks on iPhone (`design/ios-sizing.md`): every size a card or a
// sub-row has; one marked "× s" grows with Subheadline's Dynamic Type scale.

extension Palette {
    /// Happy's stylesheet colours (`--happy-text`, `-muted`, `-accent`, `-added`, `-removed`).
    public static let taskText = ColorToken("#18171a", "#f4f3f6")
    public static let taskMuted = ColorToken("#5c5862", "#b9b4c0")
    public static let taskAccent = ColorToken("#1683a3", "#3cb9d8")
    public static let taskAdded = ColorToken("#1a7f37", "#4ac26b")
    public static let taskRemoved = ColorToken("#cf222e", "#f47067")
}

public enum TaskListMetrics {
    /// `e`: the one inset on all four sides of a card's highlight.
    public static let edge: CGFloat = 9.4
    /// Rows stand `16 − e` in from the grouped card's sides, so their right edges end 16 in; the list as far in at top and bottom.
    public static let inset: CGFloat = 16 - edge
    /// A highlight is painted this far inside its row, top and bottom, so two lit rows stand 4 apart.
    public static let highlightInset: CGFloat = 2
    /// Selected: the accent at 10%; pressed: the ink at 4%.
    public static let selectedAlpha: CGFloat = 0.1
    public static let pressedAlpha: CGFloat = 0.04
    /// Every tap target at least this square (the HIG's default).
    public static let hit: CGFloat = 44

    /// The card's highlight is at least the disc and 8, rounded 14 (Telegram's row: 68 at Large).
    public static let cardRadius: CGFloat = 14
    public static let discRoom: CGFloat = 8
    /// The disc: Telegram's 60, unfilled, its art 0.8 of it, 0.7 in a story's ring (2.33 wide, the disc 4 in);
    /// a face's fill the ink at 5%; an icon's letter tile its letter at 0.45 of it.
    public static let disc: CGFloat = 60
    public static let discInk: CGFloat = 0.05
    public static let iconShare: CGFloat = 0.8
    public static let storyIconShare: CGFloat = 0.7
    public static let storyRing: CGFloat = 2.33
    public static let storyFill: CGFloat = 4
    public static let letterScale: CGFloat = 0.45
    /// Disc to text; the title's line and the time 8 apart.
    public static let textGap: CGFloat = 10
    public static let timeGap: CGFloat = 8
    /// The title's baseline to the status's first (× s), then Subheadline's leading to its second (× s).
    public static let titleToStatus: CGFloat = 18
    public static let statusLine: CGFloat = 20
    /// The status's second line stops this far (× s) before the corner, whose items stand as far apart.
    public static let cornerGap: CGFloat = 6
    /// Corner B: a lane 18 tall (× s), centred on the last status line's x-height.
    public static let chip: CGFloat = 18
    /// Each face over the one before by 30%, ringed 1.5 in the ground; a face with no picture its initial at 0.6 of it.
    public static let faceStep: CGFloat = 0.7
    public static let faceRing: CGFloat = 1.5
    public static let faces = 3
    public static let initialScale: CGFloat = 0.6
    /// The braille's 2×4 dots of 2.5: 7.5 wide (× s).
    public static let brailleWidth: CGFloat = 7.5

    /// A sub-row: Subheadline's leading and 24, at least 44, lit from 4 left of its mark (× s), rounded 10.
    public static let subRowRoom: CGFloat = 24
    public static let subRowRadius: CGFloat = 10
    public static let markLead: CGFloat = 4
    public static let mark: CGFloat = 24
    public static let markRadius: CGFloat = 6
    public static let markInk: CGFloat = 0.06
    public static let markGlyph: CGFloat = 15
    /// A hidden row's mark, shown faded; the trail 8 after the text.
    public static let dimmed: CGFloat = 0.5
    public static let trailGap: CGFloat = 8

    /// "+N more" under the sub-rows: Subheadline's leading and 20, at least 40, its text where the card's starts.
    public static let moreRoom: CGFloat = 20
    public static let moreHeight: CGFloat = 40

    /// Type: title Callout 16 semibold; time, status, sub-rows and "more" Subheadline 15, "more" semibold.
    public static let titleSize: CGFloat = 16
    public static let textSize: CGFloat = 15
    /// Body's size, by which the disc shrinks.
    public static let bodySize: CGFloat = 17
}
