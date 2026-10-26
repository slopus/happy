import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The photo library sheet, measured as Telegram's attachment gallery
/// (`MediaPickerScreen`, `MediaPickerGridItem`, `MediaPickerManageNode`):
///
///     ( Cancel ) (✓ 2)  Recents        the picks' count, once there are any:
///                                      tapped, the grid shows only them
///     ┌ You have limited Happy from …   (MANAGE) ┐   only with limited access
///     ▢▢▢   three square cells a row (five turned), 1 apart,
///     ▢▢▢   each with its number circle at the top right
///     ▢▢▢   and a video's length at the bottom right
///           (     Add 2     )                        once something is picked
public struct LibraryPickerLayout: Equatable, Sendable {
    public enum Metrics {
        /// The bar over the grid.
        public static let barHeight: CGFloat = 56
        public static let barInset: CGFloat = 16
        public static let spacing: CGFloat = 1
        public static let columns = 3
        public static let wideColumns = 5
        /// The selection circle, 3 in from the cell's top right.
        public static let check: CGFloat = 29
        public static let checkInset: CGFloat = 3
        /// A video's length, 6 in from the bottom right.
        public static let durationInset: CGFloat = 6
        /// The limited-access note: its text 16 in, its button 10 in, both
        /// 5 above the middle, in at least 64.
        public static let noteMinHeight: CGFloat = 64
        public static let noteTextInset: CGFloat = 16
        public static let noteButtonInset: CGFloat = 10
        public static let noteButtonHeight: CGFloat = 28
        public static let noteButtonPadding: CGFloat = 26
        public static let noteGap: CGFloat = 26
        public static let noteLift: CGFloat = 5
        public static let notePadding: CGFloat = 24
        /// The add button over the grid's foot.
        public static let buttonHeight: CGFloat = 50
        public static let buttonInset: CGFloat = 16
        public static let buttonBottom: CGFloat = 8
        /// Refused access: its words and Settings button, 32 in, 48 down.
        public static let blockedInset: CGFloat = 32
        public static let blockedTop: CGFloat = 48
        /// The picks' count after Cancel (`SelectedButtonNode`): 21 tall,
        /// its check 14 × 11 at 5 in, the number from 21, 28 wider than it,
        /// 12 after Cancel and never before Telegram's 72.
        public static let selectedHeight: CGFloat = 21
        public static let selectedPadding: CGFloat = 28
        public static let selectedGap: CGFloat = 12
        public static let selectedMinX: CGFloat = 72
        public static let selectedCheck = CGRect(x: 5, y: 5, width: 14, height: 11)
        public static let selectedNumberX: CGFloat = 21
    }

    public struct Input {
        public var width: CGFloat
        public var height: CGFloat
        public var safeBottom: CGFloat
        public var wide: Bool
        /// One device pixel, for the cells' width.
        public var pixel: CGFloat
        public var count: Int
        /// The limited-access note's text and button title, when shown.
        public var note: Measurable?
        public var noteButton: CGSize?
        public var title: CGSize
        public var cancel: CGSize
        /// Something is picked, so the add button shows.
        public var picking: Bool
        /// The picks' count's number, measured, while the count shows.
        public var selected: CGSize?

        public init(width: CGFloat, height: CGFloat, safeBottom: CGFloat, wide: Bool, pixel: CGFloat, count: Int, note: Measurable?, noteButton: CGSize?, title: CGSize, cancel: CGSize, picking: Bool, selected: CGSize? = nil) {
            self.width = width
            self.height = height
            self.safeBottom = safeBottom
            self.wide = wide
            self.pixel = pixel
            self.count = count
            self.note = note
            self.noteButton = noteButton
            self.title = title
            self.cancel = cancel
            self.picking = picking
            self.selected = selected
        }
    }

    public var bar: CGRect
    public var title: CGRect
    public var cancel: CGRect
    /// The scrolling grid, under the bar.
    public var grid: CGRect
    /// The note, at the top of the grid's content; the cells start under it.
    public var note: CGRect?
    public var noteText: CGRect?
    public var noteButton: CGRect?
    public var cell: CGSize
    public var columns: Int
    public var contentHeight: CGFloat
    /// Room the grid keeps at its foot for the add button.
    public var bottomInset: CGFloat
    /// The add button, shown or (with nothing picked) below the sheet.
    public var button: CGRect
    /// The picks' count, when it shows.
    public var selected: CGRect?

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.width)
        bar = CGRect(x: 0, y: 0, width: width, height: M.barHeight)
        title = CGRect(x: floor((width - input.title.width) / 2), y: floor((M.barHeight - input.title.height) / 2), width: input.title.width, height: input.title.height)
        cancel = CGRect(x: M.barInset, y: floor((M.barHeight - input.cancel.height) / 2), width: input.cancel.width, height: input.cancel.height)
        grid = CGRect(x: 0, y: M.barHeight, width: width, height: max(0, input.height - M.barHeight))

        columns = input.wide ? M.wideColumns : M.columns
        let n = CGFloat(columns)
        let pixel = max(input.pixel, 0.0001)
        let side = max(0, floor((width - M.spacing * (n - 1)) / n / pixel) * pixel)
        cell = CGSize(width: side, height: side)

        var top: CGFloat = 0
        if let note = input.note, let button = input.noteButton {
            let buttonWidth = button.width + M.noteButtonPadding
            let textWidth = max(0, width - M.noteTextInset - buttonWidth - M.noteGap)
            let text = note.size(fitting: textWidth)
            let height = max(M.noteMinHeight, text.height + M.notePadding)
            self.note = CGRect(x: 0, y: 0, width: width, height: height)
            noteText = CGRect(x: M.noteTextInset, y: floor((height - text.height) / 2) - M.noteLift, width: text.width, height: text.height)
            noteButton = CGRect(x: width - M.noteButtonInset - buttonWidth, y: floor((height - M.noteButtonHeight) / 2) - M.noteLift, width: buttonWidth, height: M.noteButtonHeight)
            top = height
        } else {
            note = nil
            noteText = nil
            noteButton = nil
        }
        self.top = top
        let rows = (input.count + columns - 1) / columns
        contentHeight = top + CGFloat(rows) * side + CGFloat(max(0, rows - 1)) * M.spacing

        let buttonY = input.picking
            ? input.height - input.safeBottom - M.buttonBottom - M.buttonHeight
            : input.height + M.buttonHeight
        button = CGRect(x: M.buttonInset, y: buttonY, width: max(0, width - 2 * M.buttonInset), height: M.buttonHeight)
        bottomInset = input.safeBottom + (input.picking ? M.buttonBottom + M.buttonHeight + M.buttonBottom : 0)
        selected = input.selected.map { number in
            CGRect(x: max(M.selectedMinX, cancel.maxX + M.selectedGap), y: floor((M.barHeight - M.selectedHeight) / 2),
                   width: ceil(number.width) + M.selectedPadding, height: M.selectedHeight)
        }
    }

    private var top: CGFloat

    /// Where cell `index` sits in the grid's content: the last column takes
    /// whatever width the rounding left.
    public func frame(at index: Int) -> CGRect {
        let row = index / columns
        let column = index % columns
        let x = column == columns - 1 ? bar.width - cell.width : CGFloat(column) * (cell.width + Metrics.spacing)
        return CGRect(x: x, y: top + CGFloat(row) * (cell.height + Metrics.spacing), width: cell.width, height: cell.height)
    }

    /// The cells showing between `minY` and `maxY` of the content.
    public func visible(minY: CGFloat, maxY: CGFloat, count: Int) -> Range<Int> {
        let pitch = cell.height + Metrics.spacing
        guard pitch > 0, count > 0 else { return 0..<0 }
        let first = max(0, Int(floor((minY - top) / pitch)))
        let last = max(0, Int(floor((maxY - top) / pitch)))
        return min(count, first * columns)..<min(count, (last + 1) * columns)
    }

    /// Refused access's text and button, `height` tall, under the bar.
    public func blocked(height: CGFloat) -> CGRect {
        CGRect(x: Metrics.blockedInset, y: grid.minY + Metrics.blockedTop, width: blockedWidth, height: height)
    }

    public var blockedWidth: CGFloat { max(0, bar.width - 2 * Metrics.blockedInset) }

    /// The selection circle in a cell's own space.
    public static func check(in cell: CGSize) -> CGRect {
        CGRect(x: cell.width - Metrics.check - Metrics.checkInset, y: Metrics.checkInset, width: Metrics.check, height: Metrics.check)
    }

    /// A video's length in a cell's own space.
    public static func duration(_ size: CGSize, in cell: CGSize) -> CGRect {
        CGRect(x: cell.width - size.width - Metrics.durationInset, y: cell.height - size.height - Metrics.durationInset, width: size.width, height: size.height)
    }

    /// "1:05": minutes and seconds, as Telegram writes a video's length.
    public static func duration(seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let rest = total % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%d:%02d", minutes, rest)
    }

    /// A number circle's font size: 16 for one digit, 15 for two, 13 for more.
    public static func numberSize(_ number: Int) -> CGFloat {
        switch String(number).count {
        case 1: 16
        case 2: 15
        default: 13
        }
    }
}
