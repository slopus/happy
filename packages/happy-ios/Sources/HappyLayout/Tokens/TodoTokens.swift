import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A todo list's sizes, over the card lists' (`CardListMetrics`): desktop's
/// todo rows (`happy-agent-todo-row`) as rows of home's inset cards.
public enum TodoMetrics {
    /// The checkbox's circle, and the tap around it: from the card's edge
    /// to the text.
    public static let check: CGFloat = 22
    public static let checkStroke: CGFloat = 1.5
    /// The check mark in a done box.
    public static let checkGlyph: CGFloat = 14
    /// Who added it, at the end of its first line.
    public static let face: CGFloat = 22
    public static let faceText: CGFloat = 10
    /// A todo's text, and the most lines it shows.
    public static let textSize: CGFloat = 16
    public static let textLines = 8
    /// A section heading (`# Groceries`) over its card.
    public static let headingSize: CGFloat = 20
    public static let headingLines = 3
    /// Above a heading after a card, and between it and its card.
    public static let headingTop: CGFloat = 26
    public static let headingBottom: CGFloat = 8
    /// "Show 3 completed": its chevron and the gap to its words.
    public static let toggleChevron: CGFloat = 12
    public static let toggleGap: CGFloat = 6
    /// The undo bar over the bottom of the list.
    public static let toastHeight: CGFloat = 50
    public static let toastSide: CGFloat = 16
    public static let toastPadding: CGFloat = 18
    public static let toastBottom: CGFloat = 12
    public static let toastGap: CGFloat = 12
    public static let toastMaxWidth: CGFloat = 480
    public static let toastTextSize: CGFloat = 15
    /// A row being dragged stands this much bigger.
    public static let liftScale: CGFloat = 1.03
}

extension Palette {
    /// A done box's fill, under its white check mark.
    public static let todoCheck = tileBlue
    /// An open box's ring.
    public static let todoRing = ColorToken("#c7c7cc", "#545458")
    /// The notice of a change the computer refused.
    public static let todoNotice = tileRed
}
