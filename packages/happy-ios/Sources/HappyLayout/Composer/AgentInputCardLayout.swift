import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The compact mobile composer's card (AgentInput.tsx `mobileUnifiedPanel`
/// and HomeDock.tsx's focused composer, which share every metric):
///
///     ┌ hairline ──────────────────────────────────────── r 30 ┐
///     │ 18 [photos 64, 8 apart, 8 below] 18                    │ 18 top
///     │    8 text (30…120 with its 4 + 4, then scrolls)  8     │ input 44+
///     │    [+42] 2 [ permission ··· model · effort ] 2 8 [42]  │ row 42
///     └────────────────────────────────────────────────────────┘ 8 bottom
///
/// The photos start where the text does, and are as far down from the
/// card's top as that is in from its side; each remove button hangs over
/// its photo's corner inside the strip, so none is cut.
///
/// `compact` puts the text in the action row, for a screen too short for
/// the card (the chat on a phone held sideways, keyboard up):
///
///     │ 8 [+42] 2 [ text (two lines, then scrolls) ] 2 [opt 42] 8 [42] 8 │ row 44+
///
/// The chips go behind the options button (`options`), which opens them;
/// the buttons keep to the row's foot as the text grows.
///
/// Frames are in the card's bounds. `middleContent` is in `middle`'s.
public struct AgentInputCardLayout: Equatable, Sendable {
    public enum Metrics {
        // AgentInputAttachmentStrip
        public static let attachmentSize: CGFloat = 64
        public static let attachmentGap: CGFloat = 8
        public static let attachmentStripPaddingH: CGFloat = 4
        public static let attachmentStripMarginH: CGFloat = 8
        public static let attachmentStripMarginBottom: CGFloat = 8
        public static let attachmentRadius: CGFloat = 8
        public static let attachmentBorder: CGFloat = 1
        public static let attachmentRemoveSize: CGFloat = 18
        public static let attachmentRemoveIconSize: CGFloat = 10
        /// The remove button hangs 6 over the thumbnail's top-right corner.
        public static let attachmentRemoveOverhang: CGFloat = 6

        /// `mobileModeText`: every chip label is 14pt.
        public static let chipFontSize: CGFloat = 14
        /// The permission chip's glyph when the mode has no name
        /// (`shield-outline`).
        public static let permissionIconSize: CGFloat = 18
        /// The primary button's glyphs: arrow-up and stop 16, the lock 14.
        public static let primaryIconSize: CGFloat = 16
        public static let lockIconSize: CGFloat = 14
        /// A disabled (non-menu) model or effort chip.
        public static let disabledChipOpacity: CGFloat = 0.58
        /// `MultiTextInput`'s `opacity: editable ? 1 : 0.58`.
        public static let readOnlyTextOpacity: CGFloat = 0.58
        /// The full-screen editor's button's glyph, once the text is past
        /// the lines the card shows (Telegram's expand). The button is
        /// send's size, in send's column.
        public static let expandIconSize: CGFloat = 18
    }

    /// Where the thumbnails sit in the strip's scrolling content: the first
    /// `leading` in and `top` down, and the content ending `trailing` past
    /// the last.
    public struct AttachmentInsets: Equatable, Sendable {
        public var leading: CGFloat
        public var top: CGFloat
        public var trailing: CGFloat

        public init(leading: CGFloat, top: CGFloat, trailing: CGFloat) {
            self.leading = leading
            self.top = top
            self.trailing = trailing
        }

        /// The desktop panel's strip: 4 in at both ends, flush with its top.
        public static let panel = AttachmentInsets(leading: Metrics.attachmentStripPaddingH, top: 0, trailing: Metrics.attachmentStripPaddingH)
    }

    /// A chip's label (or glyph), measured on one line.
    public struct Chip: Equatable, Sendable {
        public var labelSize: CGSize
        public init(labelSize: CGSize) {
            self.labelSize = labelSize
        }
    }

    public struct Input: Equatable, Sendable {
        public var width: CGFloat
        public var metrics: MobileComposerMetrics
        /// The card's border (a hairline).
        public var borderWidth: CGFloat
        public var attachmentCount: Int
        /// The text view's height for its text, its 4 + 4 padding included.
        public var textContentHeight: CGFloat
        public var hasText: Bool
        /// One line of the text as drawn, where the composer follows the
        /// person's text size; nil is the designed 22. The 44 minimum and
        /// the 120 cap stay.
        public var lineHeight: CGFloat?
        /// `minHeight` for the input container; nil keeps 44.
        public var inputMinHeight: CGFloat?
        public var showsAdd: Bool
        /// Nil hides the chip.
        public var permission: Chip?
        public var model: Chip?
        /// False draws the plain model chip (`mobileModeButton`, padding 8
        /// left) instead of the menu chip.
        public var modelIsMenu: Bool
        /// Nil hides the separator and the effort chip.
        public var effort: Chip?
        /// The "·" between model and effort.
        public var separator: CGSize
        /// AgentInput.tsx `zenMode`: no add button and no chips, whatever
        /// the rest says; the middle box stays, empty, and send keeps its
        /// place.
        public var zenMode: Bool
        /// The full-screen editor's button, shown once the text scrolls.
        public var offersExpand: Bool
        /// One row: the text between add and the options button
        /// (`compactTextCap`), the chips behind that button.
        public var compact: Bool

        /// The compact card's options button: there whenever a chip is.
        public var showsOptions: Bool {
            !zenMode && (permission != nil || model != nil || effort != nil)
        }

        public init(
            width: CGFloat,
            metrics: MobileComposerMetrics = .mobile,
            borderWidth: CGFloat = 0,
            attachmentCount: Int = 0,
            textContentHeight: CGFloat,
            hasText: Bool,
            lineHeight: CGFloat? = nil,
            inputMinHeight: CGFloat? = nil,
            showsAdd: Bool = false,
            permission: Chip? = nil,
            model: Chip? = nil,
            modelIsMenu: Bool = true,
            effort: Chip? = nil,
            separator: CGSize = .zero,
            zenMode: Bool = false,
            offersExpand: Bool = false,
            compact: Bool = false
        ) {
            self.width = width
            self.metrics = metrics
            self.borderWidth = borderWidth
            self.attachmentCount = attachmentCount
            self.textContentHeight = textContentHeight
            self.hasText = hasText
            self.lineHeight = lineHeight
            self.inputMinHeight = inputMinHeight
            self.showsAdd = showsAdd
            self.permission = permission
            self.model = model
            self.modelIsMenu = modelIsMenu
            self.effort = effort
            self.separator = separator
            self.zenMode = zenMode
            self.offersExpand = offersExpand
            self.compact = compact
        }
    }

    /// One chip in the middle box, and its label in the chip.
    public struct ChipFrame: Equatable, Sendable {
        public var frame: CGRect
        public var label: CGRect
    }

    /// Everything between add and send, in the middle box.
    public struct MiddleContent: Equatable, Sendable {
        public var permission: ChipFrame?
        public var model: ChipFrame?
        public var separator: CGRect?
        public var effort: ChipFrame?

        public init(permission: ChipFrame? = nil, model: ChipFrame? = nil, separator: CGRect? = nil, effort: ChipFrame? = nil) {
            self.permission = permission
            self.model = model
            self.separator = separator
            self.effort = effort
        }
    }

    public var size: CGSize
    /// The horizontal strip (a scroll view) across the card; its thumbnails
    /// come from `attachmentThumbnails(count:insets:)` with `attachmentInsets`.
    public var attachments: CGRect?
    public var attachmentInsets: AttachmentInsets
    public var inputContainer: CGRect
    /// The text view, its padding (`textPaddingTop`, `textPaddingBottom`)
    /// included.
    public var text: CGRect
    public var textScrolls: Bool
    /// The text view's own padding above and below its text: 4 + 4, but
    /// none on the compact card once its text scrolls, where `text` is
    /// just its two lines.
    public var textPaddingTop: CGFloat
    public var textPaddingBottom: CGFloat
    /// The full-screen editor's button, over the text's top right corner;
    /// nil until the text is taller than the card shows.
    public var expand: CGRect?
    /// Room the text keeps clear at its right for `expand`, inside its frame.
    public var textTrailingInset: CGFloat
    public var actionRow: CGRect
    public var add: CGRect?
    /// The box between add and send. It clips what it holds.
    public var middle: CGRect
    public var middleContent: MiddleContent
    public var primary: CGRect
    /// The compact card's options button; nil on the full card.
    public var options: CGRect?

    public init(_ input: Input) {
        typealias M = Metrics
        let metrics = input.metrics
        let width = max(0, input.width)
        let border = max(0, input.borderWidth)
        let contentX = border + metrics.shellInset
        let contentWidth = max(0, width - 2 * border - 2 * metrics.shellInset)
        var y = border + metrics.shellPaddingTop
        let insets = AgentInputInsets(shellInset: metrics.shellInset, actionSize: metrics.actionSize, addIconSize: metrics.addIconSize)

        // The strip runs edge to edge, so photos scroll under the card's
        // side; it starts the overhang above the photos for their buttons.
        let textLeft = contentX + insets.inputContainerPaddingLeft
        let inside = textLeft - border
        if input.attachmentCount > 0 {
            let photoTop = textLeft
            attachments = CGRect(
                x: border,
                y: photoTop - M.attachmentRemoveOverhang,
                width: max(0, width - 2 * border),
                height: M.attachmentRemoveOverhang + M.attachmentSize
            )
            y = photoTop + M.attachmentSize + M.attachmentStripMarginBottom
        } else {
            attachments = nil
        }
        attachmentInsets = AttachmentInsets(leading: inside, top: M.attachmentRemoveOverhang, trailing: inside)

        if input.compact {
            let columns = Self.compactColumns(width: width, borderWidth: border, metrics: metrics, input: input)
            let lineHeight = input.lineHeight ?? metrics.inputLineHeight
            let text = MultiTextInputLayout(
                contentHeight: input.textContentHeight,
                hasText: input.hasText,
                maxHeight: Self.compactTextCap(lineHeight: lineHeight, metrics: metrics),
                lineHeight: lineHeight,
                paddingTop: metrics.inputPaddingTop,
                paddingBottom: metrics.inputPaddingBottom
            )
            let minimum = input.inputMinHeight ?? metrics.inputMinHeight
            let containerHeight = max(minimum, text.height + metrics.inputPaddingTop + metrics.inputPaddingBottom)
            inputContainer = CGRect(x: columns.containerX, y: y, width: columns.containerWidth, height: containerHeight)
            var textFrame = CGRect(
                x: columns.containerX + insets.inputContainerPaddingLeft,
                y: y + metrics.inputPaddingTop + (containerHeight - metrics.inputPaddingTop - metrics.inputPaddingBottom - text.height) / 2,
                width: max(0, columns.containerWidth - insets.inputContainerPaddingLeft - insets.inputContainerPaddingRight),
                height: text.height
            )
            textScrolls = text.scrollEnabled
            if textScrolls {
                // Scrolled, the text shows its two lines and nothing else:
                // no padding inside to scroll away and bare part of a line
                // at the top. Following the caret then rests on whole lines.
                let lines = 2 * lineHeight
                textFrame.origin.y += metrics.inputPaddingTop + (textFrame.height - metrics.inputPaddingTop - metrics.inputPaddingBottom - lines) / 2
                textFrame.size.height = lines
                textPaddingTop = 0
                textPaddingBottom = 0
            } else {
                textPaddingTop = metrics.inputPaddingTop
                textPaddingBottom = metrics.inputPaddingBottom
            }
            self.text = textFrame
            if input.offersExpand, textScrolls {
                let size = metrics.primaryActionSize
                let expand = CGRect(x: inputContainer.maxX - size, y: inputContainer.minY, width: size, height: size)
                self.expand = expand
                textTrailingInset = max(0, self.text.maxX - expand.minX)
            } else {
                expand = nil
                textTrailingInset = 0
            }
            // The buttons stand where they do beside one line, however
            // many the text grows to.
            let centreY = y + containerHeight - minimum / 2
            func button(_ x: CGFloat, _ size: CGFloat) -> CGRect {
                CGRect(x: x, y: centreY - size / 2, width: size, height: size)
            }
            actionRow = CGRect(x: contentX, y: y, width: contentWidth, height: containerHeight)
            add = columns.add.map { button($0, metrics.actionSize) }
            options = columns.options.map { button($0, metrics.actionSize) }
            primary = button(columns.primary, metrics.primaryActionSize)
            middle = CGRect(x: inputContainer.maxX, y: y, width: 0, height: containerHeight)
            middleContent = MiddleContent()
            y += containerHeight + metrics.shellPaddingBottom + border
            size = CGSize(width: width, height: y)
            return
        }
        options = nil
        textPaddingTop = metrics.inputPaddingTop
        textPaddingBottom = metrics.inputPaddingBottom

        // The input container centres the text view in its padding box.
        let text = MultiTextInputLayout(
            contentHeight: input.textContentHeight,
            hasText: input.hasText,
            maxHeight: metrics.inputMaxHeight,
            lineHeight: input.lineHeight ?? metrics.inputLineHeight,
            paddingTop: metrics.inputPaddingTop,
            paddingBottom: metrics.inputPaddingBottom
        )
        let containerHeight = max(
            input.inputMinHeight ?? metrics.inputMinHeight,
            text.height + metrics.inputPaddingTop + metrics.inputPaddingBottom
        )
        inputContainer = CGRect(x: contentX, y: y, width: contentWidth, height: containerHeight)
        let innerHeight = containerHeight - metrics.inputPaddingTop - metrics.inputPaddingBottom
        self.text = CGRect(
            x: contentX + insets.inputContainerPaddingLeft,
            y: y + metrics.inputPaddingTop + (innerHeight - text.height) / 2,
            width: max(0, contentWidth - insets.inputContainerPaddingLeft - insets.inputContainerPaddingRight),
            height: text.height
        )
        textScrolls = text.scrollEnabled
        // Past the lines the card shows (the sixth on): send's size, over
        // send in its column, at the input's top (the card's top, 8 in, as
        // send is 8 in from its foot, unless photos are above); the lines
        // wrap clear of it.
        if input.offersExpand, textScrolls {
            let size = metrics.primaryActionSize
            let expand = CGRect(x: contentX + contentWidth - size, y: inputContainer.minY, width: size, height: size)
            self.expand = expand
            textTrailingInset = max(0, self.text.maxX - expand.minX)
        } else {
            expand = nil
            textTrailingInset = 0
        }
        y += containerHeight

        // [+] [middle, flex 1] [send, 8 margin], 2 apart.
        actionRow = CGRect(x: contentX, y: y, width: contentWidth, height: metrics.actionRowHeight)
        let gap = metrics.actionRowGeometry.gap ?? 0
        var middleX = actionRow.minX
        if input.showsAdd, !input.zenMode {
            add = CGRect(
                x: actionRow.minX,
                y: actionRow.minY + (metrics.actionRowHeight - metrics.actionSize) / 2,
                width: metrics.actionSize,
                height: metrics.actionSize
            )
            middleX += metrics.actionSize + gap
        } else {
            add = nil
        }
        primary = CGRect(
            x: actionRow.maxX - metrics.primaryActionSize,
            y: actionRow.minY + (metrics.actionRowHeight - metrics.primaryActionSize) / 2,
            width: metrics.primaryActionSize,
            height: metrics.primaryActionSize
        )
        middle = CGRect(
            x: middleX,
            y: actionRow.minY,
            width: max(0, primary.minX - metrics.primaryActionMarginLeft - gap - middleX),
            height: metrics.actionRowHeight
        )
        middleContent = input.zenMode ? MiddleContent() : Self.middle(input, width: middle.width)
        y += metrics.actionRowHeight + metrics.shellPaddingBottom + border
        size = CGSize(width: width, height: y)
    }

    /// The middle box as Yoga lays out
    /// `[permission] [spacer, flex 1] [model] [·] [effort ≥ 64]`, 2 apart:
    /// the spacer takes the slack, and only the model gives way when there
    /// is none. Chips are 40 tall in the 42pt row.
    ///
    /// Labels sit where iOS's native menu triggers draw them over the chip:
    /// centred in the permission chip, flush right in the model's, flush
    /// left in the effort's, cut to the chip.
    static func middle(_ input: Input, width: CGFloat) -> MiddleContent {
        let metrics = input.metrics
        let gap = metrics.middleGeometry.gap ?? 0
        let chipHeight = metrics.secondaryActionHeight
        let rowHeight = metrics.actionRowHeight
        let permissionStyle = metrics.menuGeometry(.permission).content
        let effort = metrics.menuGeometry(.effort)
        let modelStyle = input.modelIsMenu
            ? metrics.menuGeometry(.model).content
            // `mobileModeButton`: paddingHorizontal 8, then paddingRight 0.
            : ComposerGeometryStyle(paddingLeft: 8, paddingRight: 0)

        let permissionWidth = input.permission.map {
            permissionStyle.resolvedPaddingLeft + $0.labelSize.width + permissionStyle.resolvedPaddingRight
        }
        let modelBasis = input.model.map {
            modelStyle.resolvedPaddingLeft + $0.labelSize.width + modelStyle.resolvedPaddingRight
        } ?? 0
        let effortWidth = input.effort.map {
            max(effort.frame.minWidth ?? 0, effort.content.resolvedPaddingLeft + $0.labelSize.width + effort.content.resolvedPaddingRight)
        }

        // The spacer is always there; so is the model's slot.
        var items = 1 + (input.model == nil ? 0 : 1)
        var fixed: CGFloat = 0
        if let permissionWidth {
            items += 1
            fixed += permissionWidth
        }
        if let effortWidth {
            items += 2
            fixed += input.separator.width + effortWidth
        }
        let free = width - CGFloat(items - 1) * gap - fixed - modelBasis
        let spacer = max(0, free)
        let model = free < 0 ? max(0, modelBasis + free) : modelBasis

        let chipY = (rowHeight - chipHeight) / 2
        func label(_ size: CGSize, in frame: CGRect, align: (CGFloat) -> CGFloat) -> CGRect {
            let labelWidth = min(size.width, frame.width)
            return CGRect(x: align(labelWidth), y: (frame.height - size.height) / 2, width: labelWidth, height: size.height)
        }

        var content = MiddleContent()
        var x: CGFloat = 0
        if let permissionWidth, let chip = input.permission {
            let frame = CGRect(x: x, y: chipY, width: permissionWidth, height: chipHeight)
            content.permission = ChipFrame(frame: frame, label: label(chip.labelSize, in: frame) { (frame.width - $0) / 2 })
            x += permissionWidth + gap
        }
        x += spacer
        if let chip = input.model {
            x += gap
            let frame = CGRect(x: x, y: chipY, width: model, height: chipHeight)
            content.model = ChipFrame(frame: frame, label: label(chip.labelSize, in: frame) { frame.width - $0 })
            x += model
        }
        if let effortWidth, let chip = input.effort {
            x += gap
            content.separator = CGRect(
                x: x,
                y: (rowHeight - input.separator.height) / 2,
                width: input.separator.width,
                height: input.separator.height
            )
            x += input.separator.width + gap
            let frame = CGRect(x: x, y: chipY, width: effortWidth, height: chipHeight)
            content.effort = ChipFrame(frame: frame, label: label(chip.labelSize, in: frame) { _ in 0 })
        }
        return content
    }

    /// The compact card's text cap, its padding included: two lines show,
    /// and the third scrolls, as the full card's 120 shows five (and 2).
    public static func compactTextCap(lineHeight: CGFloat, metrics: MobileComposerMetrics = .mobile) -> CGFloat {
        2 * lineHeight + metrics.inputPaddingTop + metrics.inputPaddingBottom + 2
    }

    /// Where the compact card's columns start: add, the text's container
    /// and how wide it is, the options button and send.
    public struct CompactColumns: Equatable, Sendable {
        public var add: CGFloat?
        public var containerX: CGFloat
        public var containerWidth: CGFloat
        public var options: CGFloat?
        public var primary: CGFloat
    }

    public static func compactColumns(width: CGFloat, borderWidth: CGFloat, metrics: MobileComposerMetrics, input: Input) -> CompactColumns {
        let border = max(0, borderWidth)
        let contentX = border + metrics.shellInset
        let contentMaxX = max(contentX, width - border - metrics.shellInset)
        let gap = metrics.actionRowGeometry.gap ?? 0
        let primary = contentMaxX - metrics.primaryActionSize
        let options = input.showsOptions ? primary - metrics.primaryActionMarginLeft - metrics.actionSize : nil
        let containerMaxX = (options ?? primary - metrics.primaryActionMarginLeft) - gap
        let add = input.showsAdd && !input.zenMode ? contentX : nil
        let containerX = add.map { $0 + metrics.actionSize + gap } ?? contentX
        return CompactColumns(add: add, containerX: containerX, containerWidth: max(0, containerMaxX - containerX), options: options, primary: primary)
    }

    /// The width the text wraps at, inside its container: what its height
    /// is measured at.
    public static func textWidth(_ input: Input) -> CGFloat {
        let metrics = input.metrics
        let border = max(0, input.borderWidth)
        let insets = AgentInputInsets(shellInset: metrics.shellInset, actionSize: metrics.actionSize, addIconSize: metrics.addIconSize)
        let container = input.compact
            ? compactColumns(width: max(0, input.width), borderWidth: border, metrics: metrics, input: input).containerWidth
            : max(0, input.width - 2 * border - 2 * metrics.shellInset)
        return max(0, container - insets.inputContainerPaddingLeft - insets.inputContainerPaddingRight)
    }

    /// The thumbnails in the attachment strip's scrolling content, and that
    /// content's width: 64pt squares 8 apart, placed by `insets`.
    public static func attachmentThumbnails(count: Int, insets: AttachmentInsets = .panel) -> (frames: [CGRect], contentWidth: CGFloat) {
        typealias M = Metrics
        let count = max(0, count)
        let frames = (0..<count).map { index in
            CGRect(
                x: insets.leading + CGFloat(index) * (M.attachmentSize + M.attachmentGap),
                y: insets.top,
                width: M.attachmentSize,
                height: M.attachmentSize
            )
        }
        let contentWidth = frames.last.map { $0.maxX + insets.trailing } ?? 0
        return (frames, contentWidth)
    }

    /// A thumbnail's remove button, in the thumbnail: 18pt, 6 over its
    /// top-right corner.
    public static let attachmentRemoveButton = CGRect(
        x: Metrics.attachmentSize + Metrics.attachmentRemoveOverhang - Metrics.attachmentRemoveSize,
        y: -Metrics.attachmentRemoveOverhang,
        width: Metrics.attachmentRemoveSize,
        height: Metrics.attachmentRemoveSize
    )
}
