import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// ToolView.tsx and the pieces tool rows are built from. A tool row sits in
// MessageView's toolContainer, 8 in from each side of the column.

/// The column a tool row draws in: ChatColumn less 8 on each side.
public enum ToolRowMetrics {
    public static let containerMarginH: CGFloat = 8

    public static func cardFrame(rowWidth: CGFloat, maxContentWidth: CGFloat) -> (x: CGFloat, width: CGFloat) {
        let column = ChatColumn(rowWidth: rowWidth, maxContentWidth: maxContentWidth)
        return (column.x + containerMarginH, max(0, column.width - 2 * containerMarginH))
    }
}

/// A full tool card:
///
///     8
///     ┌ header (surfaceHighest), 12 padding ──────────────────────┐
///     │ [icon 24] 8 title … status        8 [1.2s] 8 [status 20]  │
///     │             description (2 below)                          │
///     ├ body: 12 in from the sides, 8 below the header ───────────┤
///     ├ permission footer ────────────────────────────────────────┤
///     └ radius 8, surfaceHigh ─────────────────────────────────────┘
///     8
///
/// A self-heading tool (a patch, an attachment) has no header; an
/// attachment has no card either (`inline`).
public struct ToolCardLayout: Equatable, Sendable {
    public enum Metrics {
        public static let marginV: CGFloat = 8
        public static let inlineMarginV: CGFloat = 1
        public static let radius: CGFloat = 8
        public static let headerPadding: CGFloat = 12
        public static let iconSize: CGFloat = 24
        public static let gap: CGFloat = 8
        public static let descriptionMarginTop: CGFloat = 2
        public static let statusIconSize: CGFloat = 20
        public static let contentPaddingH: CGFloat = 12
        public static let contentPaddingTop: CGFloat = 8
        public static let elapsedMarginLeft: CGFloat = 8
    }

    public struct Header {
        public var title: Measurable
        public var description: Measurable?
        /// The running timer, while the tool runs.
        public var elapsed: Measurable?
        /// Spinner or state glyph.
        public var statusIcon: CGSize?

        public init(title: Measurable, description: Measurable? = nil, elapsed: Measurable? = nil, statusIcon: CGSize? = nil) {
            self.title = title
            self.description = description
            self.elapsed = elapsed
            self.statusIcon = statusIcon
        }
    }

    public struct Input {
        public var width: CGFloat
        public var maxContentWidth: CGFloat
        public var header: Header?
        /// The tool's own view, laid out `width - 24` wide.
        public var body: Measurable?
        /// PermissionFooter, laid out the card's full width.
        public var footer: Measurable?
        /// An attachment: no card, no padding.
        public var inline: Bool

        public init(width: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude, header: Header?, body: Measurable?, footer: Measurable?, inline: Bool = false) {
            self.width = width
            self.maxContentWidth = maxContentWidth
            self.header = header
            self.body = body
            self.footer = footer
            self.inline = inline
        }
    }

    public var size: CGSize
    public var card: CGRect
    public var header: CGRect?
    public var icon: CGRect?
    public var title: CGRect?
    public var description: CGRect?
    public var elapsed: CGRect?
    public var statusIcon: CGRect?
    public var body: CGRect?
    public var footer: CGRect?

    public init(_ input: Input) {
        typealias M = Metrics
        let (x, width) = ToolRowMetrics.cardFrame(rowWidth: input.width, maxContentWidth: input.maxContentWidth)
        let marginV = input.inline ? M.inlineMarginV : M.marginV
        var y: CGFloat = 0

        icon = nil
        title = nil
        description = nil
        elapsed = nil
        statusIcon = nil
        if let header = input.header {
            // Right to left: status glyph, timer, then the title takes the rest.
            var right = width - M.headerPadding
            var statusFrame: CGRect?
            var elapsedFrame: CGRect?
            let elapsedSize = header.elapsed?.size(fitting: width)
            let contentHeight: CGFloat
            let titleX = M.headerPadding + M.iconSize + M.gap
            if let status = header.statusIcon {
                statusFrame = CGRect(x: right - status.width, y: 0, width: status.width, height: status.height)
                right -= status.width + M.gap
            }
            if let elapsedSize {
                elapsedFrame = CGRect(x: right - elapsedSize.width, y: 0, width: elapsedSize.width, height: elapsedSize.height)
                right -= elapsedSize.width + M.elapsedMarginLeft + M.gap
            }
            let titleWidth = max(0, right - titleX)
            let titleHeight = header.title.height(fitting: titleWidth)
            let descriptionHeight = header.description?.height(fitting: titleWidth)
            let columnHeight = titleHeight + (descriptionHeight.map { M.descriptionMarginTop + $0 } ?? 0)
            contentHeight = max(M.iconSize, columnHeight, elapsedSize?.height ?? 0, statusFrame?.height ?? 0)
            let top = M.headerPadding
            func centred(_ height: CGFloat) -> CGFloat { top + (contentHeight - height) / 2 }
            icon = CGRect(x: M.headerPadding, y: centred(M.iconSize), width: M.iconSize, height: M.iconSize)
            let columnTop = centred(columnHeight)
            title = CGRect(x: titleX, y: columnTop, width: titleWidth, height: titleHeight)
            if let descriptionHeight {
                description = CGRect(x: titleX, y: columnTop + titleHeight + M.descriptionMarginTop, width: titleWidth, height: descriptionHeight)
            }
            if var frame = elapsedFrame {
                frame.origin.y = centred(frame.height)
                elapsed = frame
            }
            if var frame = statusFrame {
                frame.origin.y = centred(frame.height)
                statusIcon = frame
            }
            let headerHeight = contentHeight + 2 * M.headerPadding
            self.header = CGRect(x: 0, y: 0, width: width, height: headerHeight)
            y = headerHeight
        } else {
            header = nil
        }

        if let bodyContent = input.body {
            let padH: CGFloat = input.inline ? 0 : M.contentPaddingH
            let padTop: CGFloat = input.inline ? 0 : M.contentPaddingTop
            let bodyWidth = max(0, width - 2 * padH)
            let height = bodyContent.height(fitting: bodyWidth)
            body = CGRect(x: padH, y: y + padTop, width: bodyWidth, height: height)
            y += padTop + height
        } else {
            body = nil
        }

        if let footerContent = input.footer {
            let height = footerContent.height(fitting: width)
            footer = CGRect(x: 0, y: y, width: width, height: height)
            y += height
        } else {
            footer = nil
        }

        card = CGRect(x: x, y: marginV, width: width, height: y)
        size = CGSize(width: max(0, input.width), height: y + 2 * marginV)
    }
}

/// The one-line activity row (compact tool calls, terminals, unknown tools):
///
///     2
///     8 [icon 20] 10 label ………………… 8 [1.2s] 10 [status]   min 28, 3 padding
///     ┌ body, once opened: surfaceHigh, 12 in, 8 down ┐       2 below the row
///     [permission footer]
///     2
///
/// happy-app's compact row has no body; here a tapped row opens to the
/// same body a card would show.
public struct CompactToolRowLayout: Equatable, Sendable {
    public enum Metrics {
        public static let marginV: CGFloat = 2
        public static let minHeight: CGFloat = 28
        public static let paddingH: CGFloat = 8
        public static let paddingV: CGFloat = 3
        public static let iconSize: CGFloat = 20
        public static let gap: CGFloat = 10
        public static let elapsedMarginLeft: CGFloat = 8
        public static let bodyMarginTop: CGFloat = 2
        public static let bodyRadius: CGFloat = 8
    }

    public var size: CGSize
    /// The tap target (it opens and closes the body).
    public var header: CGRect
    public var icon: CGRect
    public var label: CGRect
    public var elapsed: CGRect?
    public var statusIcon: CGRect?
    /// The opened body's box, and its content inside the card padding.
    public var bodyBox: CGRect?
    public var body: CGRect?
    public var footer: CGRect?

    public init(
        width: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude, label: Measurable, elapsed: Measurable?, statusIcon: CGSize?,
        body: Measurable? = nil, footer: Measurable?
    ) {
        typealias M = Metrics
        let (x, cardWidth) = ToolRowMetrics.cardFrame(rowWidth: width, maxContentWidth: maxContentWidth)
        var right = x + cardWidth - M.paddingH
        var statusFrame: CGRect?
        var elapsedFrame: CGRect?
        if let status = statusIcon {
            statusFrame = CGRect(x: right - status.width, y: 0, width: status.width, height: status.height)
            right -= status.width + M.gap
        }
        if let elapsed {
            let size = elapsed.size(fitting: cardWidth)
            elapsedFrame = CGRect(x: right - size.width, y: 0, width: size.width, height: size.height)
            // The timer's own 8 pt margin sits inside the 10 pt gap before it.
            right -= size.width + M.elapsedMarginLeft + M.gap
        }
        let labelX = x + M.paddingH + M.iconSize + M.gap
        let labelWidth = max(0, right - labelX)
        let labelHeight = label.height(fitting: labelWidth)
        let contentHeight = max(M.iconSize, labelHeight, elapsedFrame?.height ?? 0, statusFrame?.height ?? 0)
        let headerHeight = max(M.minHeight, contentHeight + 2 * M.paddingV)
        let top = M.marginV
        func centred(_ height: CGFloat) -> CGFloat { top + (headerHeight - height) / 2 }
        header = CGRect(x: x, y: top, width: cardWidth, height: headerHeight)
        icon = CGRect(x: x + M.paddingH, y: centred(M.iconSize), width: M.iconSize, height: M.iconSize)
        self.label = CGRect(x: labelX, y: centred(labelHeight), width: labelWidth, height: labelHeight)
        self.elapsed = elapsedFrame.map { CGRect(x: $0.minX, y: centred($0.height), width: $0.width, height: $0.height) }
        self.statusIcon = statusFrame.map { CGRect(x: $0.minX, y: centred($0.height), width: $0.width, height: $0.height) }
        var y = top + headerHeight
        if let body {
            typealias Card = ToolCardLayout.Metrics
            let contentWidth = max(0, cardWidth - 2 * Card.contentPaddingH)
            let height = body.height(fitting: contentWidth)
            y += M.bodyMarginTop
            bodyBox = CGRect(x: x, y: y, width: cardWidth, height: Card.contentPaddingTop + height)
            self.body = CGRect(x: x + Card.contentPaddingH, y: y + Card.contentPaddingTop, width: contentWidth, height: height)
            y += Card.contentPaddingTop + height
        } else {
            bodyBox = nil
            self.body = nil
        }
        if let footer {
            let height = footer.height(fitting: cardWidth)
            self.footer = CGRect(x: x, y: y, width: cardWidth, height: height)
            y += height
        } else {
            self.footer = nil
        }
        size = CGSize(width: max(0, width), height: y + M.marginV)
    }
}

/// A vertical stack of boxes, the building block of tool bodies
/// (ToolSectionView, CommandView, CodeView, ToolError, the todo list…).
/// Each item has margins, padding and a horizontal placement; content is
/// measured at the width the padding leaves.
public struct ChatStackLayout: Equatable, Sendable {
    public enum Placement: Equatable, Sendable {
        /// As wide as the stack.
        case fill
        /// As wide as its content, on the left.
        case leading
        /// As wide as its content, centred.
        case center
    }

    public struct Item {
        public var content: Measurable
        public var marginTop: CGFloat
        public var marginBottom: CGFloat
        public var padding: LayoutInsets
        public var placement: Placement
        /// Content taller than this is clipped (ToolError's maxHeight).
        public var maxHeight: CGFloat?

        public init(_ content: Measurable, marginTop: CGFloat = 0, marginBottom: CGFloat = 0, padding: LayoutInsets = .zero, placement: Placement = .fill, maxHeight: CGFloat? = nil) {
            self.content = content
            self.marginTop = marginTop
            self.marginBottom = marginBottom
            self.padding = padding
            self.placement = placement
            self.maxHeight = maxHeight
        }
    }

    public var size: CGSize
    /// Each item's box (background, border).
    public var boxes: [CGRect]
    /// Each item's content, inside its padding.
    public var contents: [CGRect]

    public init(width: CGFloat, items: [Item], gap: CGFloat = 0) {
        let width = max(0, width)
        var y: CGFloat = 0
        var boxes: [CGRect] = []
        var contents: [CGRect] = []
        for (index, item) in items.enumerated() {
            if index > 0 { y += gap }
            y += item.marginTop
            let innerWidth = max(0, width - item.padding.horizontal)
            let measured = item.content.size(fitting: innerWidth)
            let contentWidth = item.placement == .fill ? innerWidth : measured.width
            var boxHeight = measured.height + item.padding.vertical
            if let maxHeight = item.maxHeight { boxHeight = min(boxHeight, maxHeight) }
            let boxWidth = contentWidth + item.padding.horizontal
            let x: CGFloat = item.placement == .center ? (width - boxWidth) / 2 : 0
            boxes.append(CGRect(x: x, y: y, width: boxWidth, height: boxHeight))
            contents.append(CGRect(
                x: x + item.padding.left,
                y: y + item.padding.top,
                width: contentWidth,
                height: max(0, min(measured.height, boxHeight - item.padding.vertical))
            ))
            y += boxHeight + item.marginBottom
        }
        self.boxes = boxes
        self.contents = contents
        size = CGSize(width: width, height: y)
    }

    /// The stack as content for an enclosing layout.
    public static func measurable(items: @escaping (CGFloat) -> [Item], gap: CGFloat = 0) -> Measurable {
        Measurable { width in ChatStackLayout(width: width, items: items(width), gap: gap).size }
    }
}

/// PermissionFooter: a column of outlined buttons, 7 apart, stretched
/// across the card on a phone, in a list no taller than `maxListHeight`
/// (`optionsScroll`) that scrolls past it.
///
///     4
///     6 ┌ 1 border, 7 ─ label (14/18, centred) ─ 7 ┐ 6   min 34
///     …
///     8
public struct PermissionFooterLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingH: CGFloat = 6
        public static let paddingTop: CGFloat = 4
        public static let paddingBottom: CGFloat = 8
        public static let gap: CGFloat = 7
        public static let buttonPaddingH: CGFloat = 10
        public static let buttonPaddingV: CGFloat = 7
        public static let buttonBorder: CGFloat = 1
        public static let buttonMinHeight: CGFloat = 34
        public static let buttonRadius: CGFloat = 7
        public static let inactiveOpacity: CGFloat = 0.52
        /// min(260, 35% of the window): taller lists scroll.
        public static let maxListHeight: CGFloat = 260
    }

    public var size: CGSize
    /// Where the buttons would be with the list scrolled to its top.
    public var buttons: [CGRect]
    public var labels: [CGRect]
    /// The list's visible part, in the footer.
    public var list: CGRect
    /// The whole list, taller than `list` when it scrolls.
    public var listContentHeight: CGFloat
    public var scrolls: Bool { listContentHeight > list.height }

    /// `optionsScroll`'s maxHeight for a window `height` tall.
    public static func maxListHeight(windowHeight height: CGFloat) -> CGFloat {
        min(Metrics.maxListHeight, (max(0, height) * 0.35).rounded())
    }

    public init(width: CGFloat, labels input: [Measurable], maxListHeight: CGFloat = .greatestFiniteMagnitude) {
        typealias M = Metrics
        let width = max(0, width)
        let buttonWidth = max(0, width - 2 * M.paddingH)
        let labelWidth = max(0, buttonWidth - 2 * (M.buttonPaddingH + M.buttonBorder))
        var y = M.paddingTop
        var buttons: [CGRect] = []
        var labels: [CGRect] = []
        for (index, label) in input.enumerated() {
            if index > 0 { y += M.gap }
            let text = label.size(fitting: labelWidth)
            let height = max(M.buttonMinHeight, text.height + 2 * (M.buttonPaddingV + M.buttonBorder))
            buttons.append(CGRect(x: M.paddingH, y: y, width: buttonWidth, height: height))
            labels.append(CGRect(x: M.paddingH + (buttonWidth - text.width) / 2, y: y + (height - text.height) / 2, width: text.width, height: text.height))
            y += height
        }
        self.buttons = buttons
        self.labels = labels
        listContentHeight = y - M.paddingTop
        list = CGRect(x: M.paddingH, y: M.paddingTop, width: buttonWidth, height: min(listContentHeight, max(0, maxListHeight)))
        size = CGSize(width: width, height: list.maxY + M.paddingBottom)
    }
}

/// A line of text with a fixed-size glyph before or after it: ToolError's
/// warning sign (top-aligned, 8 before the text), TaskView's status (centred,
/// 8 after the text).
public struct ChatAccessoryRowLayout: Equatable, Sendable {
    public enum Alignment: Equatable, Sendable {
        case top
        case center
    }

    public var size: CGSize
    public var leading: CGRect?
    public var text: CGRect
    public var trailing: CGRect?

    public init(width: CGFloat, leading: CGSize? = nil, text: Measurable, trailing: CGSize? = nil, gap: CGFloat = 8, alignment: Alignment = .center) {
        let width = max(0, width)
        let textX = leading.map { $0.width + gap } ?? 0
        let textRight = width - (trailing.map { $0.width + gap } ?? 0)
        let textWidth = max(0, textRight - textX)
        let textHeight = text.height(fitting: textWidth)
        let height = max(textHeight, leading?.height ?? 0, trailing?.height ?? 0)
        func y(_ itemHeight: CGFloat) -> CGFloat { alignment == .top ? 0 : (height - itemHeight) / 2 }
        self.leading = leading.map { CGRect(x: 0, y: y($0.height), width: $0.width, height: $0.height) }
        self.text = CGRect(x: textX, y: y(textHeight), width: textWidth, height: textHeight)
        self.trailing = trailing.map { CGRect(x: width - $0.width, y: y($0.height), width: $0.width, height: $0.height) }
        size = CGSize(width: width, height: height)
    }
}

/// FileView, a picture a person attached: the picture at its own size, at
/// most 280 wide and 360 tall (4:3 at 280 when the message doesn't give its
/// size) and never wider than the row, rounded 8, its name 4 under it, 12
/// and 8 inside. A picture that couldn't be loaded wears a 24 pt badge 4 in
/// from its top-right corner.
public struct FileViewLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingH: CGFloat = 12
        public static let paddingV: CGFloat = 8
        public static let gap: CGFloat = 4
        public static let radius: CGFloat = 8
        public static let maxImageWidth: CGFloat = 280
        public static let maxImageHeight: CGFloat = 360
        public static let defaultAspect: CGFloat = 4 / 3
        public static let badgeSize: CGFloat = 24
        public static let badgeInset: CGFloat = 4
        public static let badgeIconSize: CGFloat = 20
        /// expo-image's `transition={150}`.
        public static let fadeIn: TimeInterval = 0.15
    }

    public var size: CGSize
    public var image: CGRect
    public var name: CGRect

    public init(width: CGFloat, imageWidth: Double?, imageHeight: Double?, name: Measurable) {
        typealias M = Metrics
        let available = max(0, width - 2 * M.paddingH)
        var picture = Self.imageSize(width: imageWidth, height: imageHeight)
        if picture.width > available, picture.width > 0 {
            picture = CGSize(width: available, height: picture.height * available / picture.width)
        }
        image = CGRect(x: M.paddingH, y: M.paddingV, width: picture.width, height: picture.height)
        let nameHeight = name.height(fitting: available)
        self.name = CGRect(x: M.paddingH, y: image.maxY + M.gap, width: available, height: nameHeight)
        size = CGSize(width: max(0, width), height: self.name.maxY + M.paddingV)
    }

    /// The picture's size before the row has a say.
    public static func imageSize(width: Double?, height: Double?) -> CGSize {
        typealias M = Metrics
        let width = CGFloat(width ?? 0)
        let height = CGFloat(height ?? 0)
        let aspect = width > 0 && height > 0 ? width / height : M.defaultAspect
        var displayWidth = min(width > 0 ? width : M.maxImageWidth, M.maxImageWidth)
        var displayHeight = displayWidth / aspect
        if displayHeight > M.maxImageHeight {
            displayHeight = M.maxImageHeight
            displayWidth = displayHeight * aspect
        }
        return CGSize(width: displayWidth, height: displayHeight)
    }

    /// How many pixels to decode a picture of `size` pixels to: no more
    /// than the largest one FileView draws needs on a 3x screen.
    public static func decodedSize(_ size: CGSize) -> CGSize {
        typealias M = Metrics
        guard size.width > 0, size.height > 0 else { return size }
        let scale = min(1, 3 * M.maxImageWidth / size.width, 3 * M.maxImageHeight / size.height)
        return CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
    }

    /// The failed picture's badge, in the picture.
    public static func badge(in picture: CGSize) -> CGRect {
        typealias M = Metrics
        return CGRect(x: picture.width - M.badgeInset - M.badgeSize, y: M.badgeInset, width: M.badgeSize, height: M.badgeSize)
    }
}
