import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The compact mobile composer's card (AgentInput.tsx `mobileUnifiedPanel`
/// and HomeDock.tsx's focused composer, which share every metric):
///
///     ┌ hairline ──────────────────────────────────────── r 30 ┐
///     │ 10 [attachments 64, 8 below, 8 in]                  10 │ 8 top
///     │    8 text (30…120 with its 4 + 4, then scrolls)  8     │ input 44+
///     │    [+42] 2 [ permission ··· model · effort ] 2 8 [42]  │ row 42
///     └────────────────────────────────────────────────────────┘ 8 bottom
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
            zenMode: Bool = false
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
    /// The horizontal strip (a scroll view); its thumbnails come from
    /// `attachmentThumbnails(count:)`.
    public var attachments: CGRect?
    public var inputContainer: CGRect
    /// The text view, its 4 + 4 padding included.
    public var text: CGRect
    public var textScrolls: Bool
    public var actionRow: CGRect
    public var add: CGRect?
    /// The box between add and send. It clips what it holds.
    public var middle: CGRect
    public var middleContent: MiddleContent
    public var primary: CGRect

    public init(_ input: Input) {
        typealias M = Metrics
        let metrics = input.metrics
        let width = max(0, input.width)
        let border = max(0, input.borderWidth)
        let contentX = border + metrics.shellInset
        let contentWidth = max(0, width - 2 * border - 2 * metrics.shellInset)
        var y = border + metrics.shellPaddingTop

        if input.attachmentCount > 0 {
            attachments = CGRect(
                x: contentX + M.attachmentStripMarginH,
                y: y,
                width: max(0, contentWidth - 2 * M.attachmentStripMarginH),
                height: M.attachmentSize
            )
            y += M.attachmentSize + M.attachmentStripMarginBottom
        } else {
            attachments = nil
        }

        // The input container centres the text view in its padding box.
        let insets = AgentInputInsets(shellInset: metrics.shellInset, actionSize: metrics.actionSize, addIconSize: metrics.addIconSize)
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

    /// The thumbnails in the attachment strip's scrolling content, and that
    /// content's width: 4 in, 64pt squares 8 apart.
    public static func attachmentThumbnails(count: Int) -> (frames: [CGRect], contentWidth: CGFloat) {
        typealias M = Metrics
        let count = max(0, count)
        let frames = (0..<count).map { index in
            CGRect(
                x: M.attachmentStripPaddingH + CGFloat(index) * (M.attachmentSize + M.attachmentGap),
                y: 0,
                width: M.attachmentSize,
                height: M.attachmentSize
            )
        }
        let contentWidth = count > 0
            ? 2 * M.attachmentStripPaddingH + CGFloat(count) * M.attachmentSize + CGFloat(count - 1) * M.attachmentGap
            : 0
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
