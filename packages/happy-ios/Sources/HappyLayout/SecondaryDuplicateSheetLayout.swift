import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// components/DuplicateSheet.tsx: a card centred over a dimmed backdrop
/// with a header (title, subtitle), a list of rewind points capped at 420
/// and an action bar (Cancel, Duplicate). Sized by
/// utils/duplicateSheetLayout.ts: `min(560, width - 32)` wide, at most 85%
/// of the window tall; the list shrinks first.
public struct DuplicateSheetLayout: Equatable, Sendable {
    public enum Metrics {
        public static let horizontalMargin: CGFloat = 16
        public static let maxWidth: CGFloat = 560
        public static let maxHeightRatio: CGFloat = 0.85
        public static let cornerRadius: CGFloat = 16
        public static let headerPaddingHorizontal: CGFloat = 20
        public static let headerPaddingTop: CGFloat = 20
        public static let headerPaddingBottom: CGFloat = 12
        public static let subtitleSpacing: CGFloat = 4
        public static let listMaxHeight: CGFloat = 420
        public static let listPaddingVertical: CGFloat = 8
        public static let rowPaddingHorizontal: CGFloat = 20
        public static let rowPaddingVertical: CGFloat = 12
        public static let rowMetaSpacing: CGFloat = 4
        public static let messagePaddingVertical: CGFloat = 32
        public static let messagePaddingHorizontal: CGFloat = 20
        public static let actionsPadding: CGFloat = 16
        public static let actionsGap: CGFloat = 8
        public static let buttonPaddingVertical: CGFloat = 11
        public static let buttonCornerRadius: CGFloat = 10
    }

    /// What fills the list.
    public enum Body {
        /// A spinner of this size.
        case loading(CGSize)
        /// An error or the empty copy, centred.
        case message(Measurable)
        /// Each point's text (three lines at most) and its age.
        case rows([(text: Measurable, meta: Measurable)])
    }

    public struct Input {
        public var window: CGSize
        public var title: Measurable
        public var subtitle: Measurable
        public var body: Body
        /// One line of the buttons' 15pt text.
        public var buttonTextHeight: CGFloat
        public var hairline: CGFloat

        public init(window: CGSize, title: Measurable, subtitle: Measurable, body: Body, buttonTextHeight: CGFloat, hairline: CGFloat) {
            self.window = window
            self.title = title
            self.subtitle = subtitle
            self.body = body
            self.buttonTextHeight = buttonTextHeight
            self.hairline = hairline
        }
    }

    public struct Row: Equatable, Sendable {
        /// In the list's content coordinates.
        public var frame: CGRect
        public var text: CGRect
        public var meta: CGRect
        public var divider: CGRect
    }

    /// The card, in window coordinates.
    public var card: CGRect
    // The rest are in the card's coordinates.
    public var title: CGRect
    public var subtitle: CGRect
    public var headerDivider: CGRect
    public var list: CGRect
    public var listContentSize: CGSize
    public var rows: [Row]
    /// The spinner or message, in the list's content coordinates.
    public var body: CGRect?
    public var actionsDivider: CGRect
    public var cancel: CGRect
    public var confirm: CGRect

    public init(_ input: Input) {
        typealias M = Metrics
        let hairline = input.hairline
        let width = min(M.maxWidth, max(0, input.window.width.rounded(.down) - M.horizontalMargin * 2))
        let maxHeight = (input.window.height.rounded(.down) * M.maxHeightRatio).rounded()
        // The card's hairline border insets everything inside it.
        let inner = max(0, width - hairline * 2)

        let textWidth = max(0, inner - M.headerPaddingHorizontal * 2)
        let titleHeight = input.title.height(fitting: textWidth)
        let subtitleHeight = input.subtitle.height(fitting: textWidth)
        title = CGRect(x: hairline + M.headerPaddingHorizontal, y: hairline + M.headerPaddingTop, width: textWidth, height: titleHeight)
        subtitle = CGRect(x: title.minX, y: title.maxY + M.subtitleSpacing, width: textWidth, height: subtitleHeight)
        headerDivider = CGRect(x: hairline, y: subtitle.maxY + M.headerPaddingBottom, width: inner, height: hairline)

        var y = M.listPaddingVertical
        var rows: [Row] = []
        var body: CGRect?
        switch input.body {
        case .loading(let size):
            body = CGRect(x: (inner - size.width) / 2, y: y + M.messagePaddingVertical, width: size.width, height: size.height)
            y = body!.maxY + M.messagePaddingVertical
        case .message(let text):
            let size = text.size(fitting: max(0, inner - M.messagePaddingHorizontal * 2))
            body = CGRect(x: (inner - size.width) / 2, y: y + M.messagePaddingVertical, width: size.width, height: size.height)
            y = body!.maxY + M.messagePaddingVertical
        case .rows(let items):
            let rowTextWidth = max(0, inner - M.rowPaddingHorizontal * 2)
            for item in items {
                let textHeight = item.text.height(fitting: rowTextWidth)
                let metaHeight = item.meta.height(fitting: rowTextWidth)
                let text = CGRect(x: M.rowPaddingHorizontal, y: y + M.rowPaddingVertical, width: rowTextWidth, height: textHeight)
                let meta = CGRect(x: M.rowPaddingHorizontal, y: text.maxY + M.rowMetaSpacing, width: rowTextWidth, height: metaHeight)
                // The hairline border is part of the row's box.
                let height = M.rowPaddingVertical * 2 + textHeight + M.rowMetaSpacing + metaHeight + hairline
                let frame = CGRect(x: 0, y: y, width: inner, height: height)
                rows.append(Row(frame: frame, text: text, meta: meta, divider: CGRect(x: 0, y: frame.maxY - hairline, width: inner, height: hairline)))
                y = frame.maxY
            }
        }
        let contentHeight = y + M.listPaddingVertical
        self.rows = rows
        self.body = body
        listContentSize = CGSize(width: inner, height: contentHeight)

        // The list is the only part that shrinks.
        let buttonHeight = M.buttonPaddingVertical * 2 + input.buttonTextHeight
        let actionsHeight = hairline + M.actionsPadding * 2 + buttonHeight
        let fixed = headerDivider.maxY + actionsHeight + hairline
        let listHeight = max(0, min(contentHeight, M.listMaxHeight, maxHeight - fixed))
        list = CGRect(x: hairline, y: headerDivider.maxY, width: inner, height: listHeight)

        actionsDivider = CGRect(x: hairline, y: list.maxY, width: inner, height: hairline)
        let buttonsY = actionsDivider.maxY + M.actionsPadding
        let buttonWidth = max(0, (inner - M.actionsPadding * 2 - M.actionsGap) / 2)
        cancel = CGRect(x: hairline + M.actionsPadding, y: buttonsY, width: buttonWidth, height: buttonHeight)
        confirm = CGRect(x: cancel.maxX + M.actionsGap, y: buttonsY, width: buttonWidth, height: buttonHeight)

        let height = cancel.maxY + M.actionsPadding + hairline
        card = CGRect(
            x: (input.window.width - width) / 2,
            y: (input.window.height - height) / 2,
            width: width,
            height: height
        )
    }

    public static func == (lhs: DuplicateSheetLayout, rhs: DuplicateSheetLayout) -> Bool {
        lhs.card == rhs.card && lhs.title == rhs.title && lhs.subtitle == rhs.subtitle && lhs.list == rhs.list
            && lhs.rows == rhs.rows && lhs.body == rhs.body && lhs.cancel == rhs.cancel && lhs.confirm == rhs.confirm
            && lhs.listContentSize == rhs.listContentSize && lhs.headerDivider == rhs.headerDivider
            && lhs.actionsDivider == rhs.actionsDivider
    }
}
