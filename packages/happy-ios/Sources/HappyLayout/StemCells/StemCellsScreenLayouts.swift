import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Stem Cells home between home's header and dock: the banner at the top
/// of the content, the list under it scrolling the whole screen, and the
/// empty state in the space the list would take.
public struct StemCellsHomeLayout: Equatable, Sendable {
    public var banner: CGRect
    public var listInsets: LayoutInsets
    public var indicatorInsets: LayoutInsets
    public var empty: CGRect

    /// `contentTop` is where content starts under the header, `chromeTop`
    /// the header's own foot, `listBottom` the room the dock keeps,
    /// `storiesHeight` the room the stories open under the header (0:
    /// closed into the title, or not drawn).
    public init(size: CGSize, contentTop: CGFloat, chromeTop: CGFloat, listBottom: CGFloat, bannerHeight: CGFloat, storiesHeight: CGFloat = 0) {
        banner = CGRect(x: 0, y: contentTop + max(0, storiesHeight), width: size.width, height: bannerHeight)
        listInsets = LayoutInsets(top: banner.maxY, left: 0, bottom: listBottom, right: 0)
        indicatorInsets = LayoutInsets(top: chromeTop, left: 0, bottom: listBottom, right: 0)
        empty = CGRect(x: 0, y: contentTop, width: size.width, height: max(0, size.height - contentTop - listBottom))
    }
}

/// Home's dock: the new-work screen's own composer card, where that screen
/// puts it with the keyboard down (`StemCellChatScreenLayout`), over a
/// scrim that rises from the screen's foot to the card's middle. The list
/// keeps clear of it as the transcript does.
public struct StemCellsDockLayout: Equatable, Sendable {
    public var card: CGRect
    public var scrim: CGRect
    /// The room under the list, from the screen's foot.
    public var listBottom: CGFloat

    public init(size: CGSize, safeArea: LayoutInsets, cardHeight: (CGFloat) -> CGFloat) {
        let screen = StemCellChatScreenLayout(size: size, safeArea: safeArea, keyboardTop: size.height, cardHeight: cardHeight)
        card = screen.card
        scrim = CGRect(x: 0, y: card.midY, width: max(0, size.width), height: max(0, size.height - card.midY))
        listBottom = screen.listBottom
    }
}

/// The note above the Stem Cells list: a card 12 in from the sides, its
/// title and detail 14 inside it, and the Turn on button at its right,
/// centred; 8 of room under the card.
public struct StemCellsBannerLayout: Equatable, Sendable {
    public enum Metrics {
        public static let inset: CGFloat = 12
        public static let padding: CGFloat = 14
        public static let buttonGap: CGFloat = 12
        public static let detailGap: CGFloat = 2
        public static let bottom: CGFloat = 8
    }

    public var size: CGSize
    public var card: CGRect
    /// The rest in the card's own space.
    public var title: CGRect
    public var detail: CGRect?
    public var button: CGRect?

    public init(width: CGFloat, title: Measurable, detail: Measurable?, button: CGSize?) {
        typealias M = Metrics
        let cardWidth = max(0, width - 2 * M.inset)
        let textWidth = max(0, cardWidth - 2 * M.padding - (button.map { $0.width + M.buttonGap } ?? 0))
        let titleHeight = title.size(fitting: textWidth).height
        self.title = CGRect(x: M.padding, y: M.padding, width: textWidth, height: titleHeight)
        var bottom = self.title.maxY
        if let detail {
            let frame = CGRect(x: M.padding, y: bottom + M.detailGap, width: textWidth, height: detail.size(fitting: textWidth).height)
            self.detail = frame
            bottom = frame.maxY
        } else {
            self.detail = nil
        }
        let cardHeight = bottom + M.padding
        card = CGRect(x: M.inset, y: 0, width: cardWidth, height: cardHeight)
        self.button = button.map { CGRect(x: cardWidth - M.padding - $0.width, y: ((cardHeight - $0.height) / 2).rounded(), width: $0.width, height: $0.height) }
        size = CGSize(width: max(0, width), height: card.height + M.bottom)
    }
}

/// No computer, or one too old: the stem cell over a line and the Pair
/// button, the three centred together in the space between the bars.
public struct StemCellsEmptyLayout: Equatable, Sendable {
    public enum Metrics {
        public static let mark: CGFloat = 64
        public static let markGap: CGFloat = 20
        public static let buttonGap: CGFloat = 24
        public static let sideInset: CGFloat = 24
        public static let maxWidth: CGFloat = 360
    }

    public var mark: CGRect
    public var label: CGRect
    public var button: CGRect?

    public init(size: CGSize, label: Measurable, button: CGSize?) {
        typealias M = Metrics
        let width = max(0, min(size.width - 2 * M.sideInset, M.maxWidth))
        let labelHeight = label.size(fitting: width).height
        let total = M.mark + M.markGap + labelHeight + (button.map { M.buttonGap + $0.height } ?? 0)
        var y = ((size.height - total) / 2).rounded()
        mark = CGRect(x: ((size.width - M.mark) / 2).rounded(), y: y, width: M.mark, height: M.mark)
        y += M.mark + M.markGap
        self.label = CGRect(x: ((size.width - width) / 2).rounded(), y: y, width: width, height: labelHeight)
        y += labelHeight + M.buttonGap
        self.button = button.map { CGRect(x: ((size.width - $0.width) / 2).rounded(), y: y, width: $0.width, height: $0.height) }
    }
}

/// Search: the bar under the navigation bar, 4 in from the sides, and the
/// list under it, scrolling the whole screen.
public struct StemCellsSearchLayout: Equatable, Sendable {
    public var bar: CGRect
    public var listInsets: LayoutInsets

    public init(width: CGFloat, safeArea: LayoutInsets, barHeight: CGFloat) {
        bar = CGRect(x: 4, y: safeArea.top, width: max(0, width - 8), height: barHeight)
        listInsets = LayoutInsets(top: bar.maxY, left: 0, bottom: safeArea.bottom, right: 0)
    }
}

/// A todo list on the phone: the field that adds one at the top, then each
/// todo with its box 16 in and its text beside it, wrapping, or a line
/// saying there are none. Content coordinates, under the bar.
public struct StemCellsTodoLayout: Equatable, Sendable {
    public enum Metrics {
        public static let inset: CGFloat = 16
        public static let top: CGFloat = 12
        public static let fieldHeight: CGFloat = 44
        public static let listGap: CGFloat = 8
        public static let box: CGFloat = 22
        public static let boxGap: CGFloat = 10
        public static let rowPadding: CGFloat = 10
        public static let minRow: CGFloat = 44
        public static let emptyGap: CGFloat = 24
        public static let bottom: CGFloat = 16
    }

    public struct Row: Equatable, Sendable {
        public var frame: CGRect
        /// In the row's own space.
        public var box: CGRect
        public var text: CGRect
    }

    public var field: CGRect
    public var rows: [Row]
    public var empty: CGRect?
    public var contentHeight: CGFloat

    public init(width: CGFloat, todos: [Measurable], empty: Measurable) {
        typealias M = Metrics
        let inner = max(0, width - 2 * M.inset)
        field = CGRect(x: M.inset, y: M.top, width: inner, height: M.fieldHeight)
        var y = field.maxY + M.listGap
        let textX = M.inset + M.box + M.boxGap
        let textWidth = max(0, width - textX - M.inset)
        rows = todos.map { todo in
            let text = todo.size(fitting: textWidth)
            let height = max(M.minRow, text.height + 2 * M.rowPadding)
            let row = Row(
                frame: CGRect(x: 0, y: y, width: max(0, width), height: height),
                box: CGRect(x: M.inset, y: ((height - M.box) / 2).rounded(), width: M.box, height: M.box),
                text: CGRect(x: textX, y: ((height - text.height) / 2).rounded(), width: textWidth, height: text.height)
            )
            y += height
            return row
        }
        if todos.isEmpty {
            let frame = CGRect(x: M.inset, y: y + M.emptyGap, width: inner, height: empty.size(fitting: inner).height)
            self.empty = frame
            y = frame.maxY
        } else {
            self.empty = nil
        }
        contentHeight = y + M.bottom
    }
}

/// A document, or a Surface the phone only names: its markdown, or a line,
/// 16 under the bar, scrolling.
public struct StemCellsSurfaceBodyLayout: Equatable, Sendable {
    public var body: CGRect
    public var contentHeight: CGFloat

    /// `body` fills the width less `inset` a side.
    public init(width: CGFloat, body: Measurable, inset: CGFloat = 0) {
        let bodyWidth = max(0, width - 2 * inset)
        self.body = CGRect(x: inset, y: 8, width: bodyWidth, height: body.size(fitting: bodyWidth).height)
        contentHeight = self.body.maxY + 16
    }
}

/// A conversation's name in its bar, renamed where it stands: as wide as
/// its text, no wider than `maxWidth`; while it is edited, the whole of
/// `maxWidth`, so the field doesn't grow under the keyboard. The text and
/// the field fill it, centred.
public struct StemCellChatTitleLayout: Equatable, Sendable {
    public static let height: CGFloat = 44
    /// The bar keeps this much clear a side, for the back button.
    public static let sideClearance: CGFloat = 64

    public var size: CGSize
    public var text: CGRect

    /// No bound while the bar's width is unknown (0): the name is as wide as
    /// its text, and the bar fits it.
    public static func maxWidth(barWidth: CGFloat) -> CGFloat {
        barWidth > 0 ? max(0, barWidth - 2 * sideClearance) : .greatestFiniteMagnitude
    }

    public init(textWidth: CGFloat, maxWidth: CGFloat, editing: Bool) {
        let fitted = min(textWidth.rounded(.up), maxWidth)
        let width = editing && maxWidth < .greatestFiniteMagnitude ? maxWidth : fitted
        size = CGSize(width: max(0, width), height: Self.height)
        text = CGRect(origin: .zero, size: size)
    }
}

/// A picture opened whole: fitted inside the safe area on black, never
/// enlarged past its own size, with its close button at the top right.
public struct StemCellPictureViewerLayout: Equatable, Sendable {
    public static let closeSize: CGFloat = 44
    public static let closeInset: CGFloat = 8

    public var picture: CGRect
    public var close: CGRect

    /// `picture` is its size in points; zero before it is known.
    public init(size: CGSize, safeArea: LayoutInsets, picture natural: CGSize) {
        let area = CGRect(x: safeArea.left, y: safeArea.top, width: max(0, size.width - safeArea.left - safeArea.right), height: max(0, size.height - safeArea.top - safeArea.bottom))
        if natural.width > 0, natural.height > 0 {
            let scale = min(1, area.width / natural.width, area.height / natural.height)
            let fitted = CGSize(width: (natural.width * scale).rounded(), height: (natural.height * scale).rounded())
            picture = CGRect(x: (area.midX - fitted.width / 2).rounded(), y: (area.midY - fitted.height / 2).rounded(), width: fitted.width, height: fitted.height)
        } else {
            picture = area
        }
        close = CGRect(x: size.width - safeArea.right - Self.closeInset - Self.closeSize, y: safeArea.top + Self.closeInset, width: Self.closeSize, height: Self.closeSize)
    }
}
