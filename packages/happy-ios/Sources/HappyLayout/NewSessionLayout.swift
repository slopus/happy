import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// new/index.tsx on a phone: the place rows sit on the composer, both
/// pinned to the foot of the screen, and ride up on the keyboard.
///
///     |   (‹) (Start New Session)                       |  52 below the status bar
///     |                                                 |
///     |20| ▭ MacBook                               ⌄ |20|  48 each
///     |20| ▭ ~/code/happy                          ⌄ |20|
///     |20| ▭ no worktree                           ⌄ |20|
///     |                                                 |  8 + 12
///     |12| ╭ Ask claude code                         ╮ |12|  98 at least
///     |12| ╰ (◎ claude code ⌄)(⚙)          (🎙)(↑) ╯ |12|
///     |                                                 |  max(12, safe bottom)
///
/// The rows are the foot of a scroll view (`mobileConfigScroll`) that
/// fills the space between the header and the composer: `flexGrow` with
/// `justifyContent: 'flex-end'` keeps them down, and a 96pt top pad keeps
/// them clear of the header once they scroll. The header is the system
/// navigation bar's, so only its bottom edge is used here.
public struct NewSessionScreenLayout: Equatable, Sendable {
    public enum Metrics {
        /// MOBILE_GLASS_HEADER_HEIGHT, below the status bar.
        public static let headerHeight: CGFloat = 52
        /// `mobileKeyboardDismissArea`.
        public static let configPaddingTop: CGFloat = 96
        /// `mobileInlineConfigWrap`.
        public static let configPaddingHorizontal: CGFloat = 20
        public static let configPaddingBottom: CGFloat = 8
        /// `mobileConfigScrollContent`.
        public static let scrollPaddingBottom: CGFloat = 12
        /// `inlineComposerWrap` and `mobileComposerShadow`.
        public static let composerPaddingHorizontal: CGFloat = 12
        /// The spacer under the composer: `Math.max(12, safeArea.bottom)`.
        public static let minPaddingBottom: CGFloat = 12

        /// `configRow`.
        public static let rowPaddingHorizontal: CGFloat = 12
        public static let rowPaddingVertical: CGFloat = 12
        public static let rowMinHeight: CGFloat = 48
        public static let rowGap: CGFloat = 8
        public static let rowRadius: CGFloat = 12
        public static let rowIconSize: CGFloat = 15
        public static let rowChevronSize: CGFloat = 13

        /// `offlineHelp`.
        public static let offlinePaddingHorizontal: CGFloat = 12
        public static let offlinePaddingVertical: CGFloat = 10
        public static let offlineGap: CGFloat = 8
        public static let offlineIconSize: CGFloat = 14
        public static let offlineTitleMarginBottom: CGFloat = 4
    }

    public enum Row {
        /// A picker row: an icon, a one-line value and a chevron.
        case config(label: Measurable)
        /// "Machine is offline" and the help under it.
        case offline(title: Measurable, body: Measurable)
    }

    public struct Input {
        public var size: CGSize
        /// The status bar: the header row starts here.
        public var safeTop: CGFloat
        public var safeBottom: CGFloat
        /// How much of the screen's foot the keyboard covers.
        public var keyboardOverlap: CGFloat
        /// `layout.maxWidth`: on a phone, the longer side of the screen.
        public var maxWidth: CGFloat
        public var composerHeight: CGFloat
        public var rows: [Row]

        public init(
            size: CGSize,
            safeTop: CGFloat,
            safeBottom: CGFloat,
            keyboardOverlap: CGFloat = 0,
            maxWidth: CGFloat = .greatestFiniteMagnitude,
            composerHeight: CGFloat,
            rows: [Row]
        ) {
            self.size = size
            self.safeTop = safeTop
            self.safeBottom = safeBottom
            self.keyboardOverlap = keyboardOverlap
            self.maxWidth = maxWidth
            self.composerHeight = composerHeight
            self.rows = rows
        }
    }

    /// A row in the scroll view's content. Offline help has a body and no
    /// chevron.
    public struct RowFrame: Equatable, Sendable {
        public var frame: CGRect
        /// Inside `frame`, as are the rest.
        public var icon: CGRect
        public var label: CGRect
        public var chevron: CGRect?
        public var body: CGRect?
    }

    /// The bottom of the header row.
    public var headerBottom: CGFloat
    /// The scroll view between the header and the composer.
    public var scroll: CGRect
    public var contentSize: CGSize
    /// The rows and their bottom pad (`mobileConfigHeight`).
    public var configHeight: CGFloat
    public var rows: [RowFrame]
    public var composer: CGRect

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.size.width)
        headerBottom = input.safeTop + M.headerHeight

        let laneWidth = min(input.maxWidth, width)
        let laneX = (width - laneWidth) / 2
        let bottom = input.size.height - input.keyboardOverlap - max(M.minPaddingBottom, input.safeBottom)
        composer = CGRect(
            x: laneX + M.composerPaddingHorizontal,
            y: bottom - input.composerHeight,
            width: max(0, laneWidth - 2 * M.composerPaddingHorizontal),
            height: input.composerHeight
        )
        scroll = CGRect(x: 0, y: headerBottom, width: width, height: max(0, composer.minY - headerBottom))

        let rowWidth = max(0, laneWidth - 2 * M.configPaddingHorizontal)
        var rows: [RowFrame] = []
        var y: CGFloat = 0
        for row in input.rows {
            let frame: RowFrame
            switch row {
            case .config(let label):
                let labelWidth = max(0, rowWidth - 2 * M.rowPaddingHorizontal - M.rowIconSize - M.rowChevronSize - 2 * M.rowGap)
                let text = label.size(fitting: labelWidth)
                let height = max(M.rowMinHeight, 2 * M.rowPaddingVertical + max(M.rowIconSize, text.height, M.rowChevronSize))
                let mid = height / 2
                let labelX = M.rowPaddingHorizontal + M.rowIconSize + M.rowGap
                frame = RowFrame(
                    frame: CGRect(x: 0, y: y, width: rowWidth, height: height),
                    icon: CGRect(x: M.rowPaddingHorizontal, y: mid - M.rowIconSize / 2, width: M.rowIconSize, height: M.rowIconSize),
                    label: CGRect(x: labelX, y: mid - text.height / 2, width: labelWidth, height: text.height),
                    chevron: CGRect(x: rowWidth - M.rowPaddingHorizontal - M.rowChevronSize, y: mid - M.rowChevronSize / 2, width: M.rowChevronSize, height: M.rowChevronSize),
                    body: nil
                )
            case .offline(let title, let body):
                let textX = M.offlinePaddingHorizontal + M.offlineIconSize + M.offlineGap
                let textWidth = max(0, rowWidth - textX - M.offlinePaddingHorizontal)
                let titleSize = title.size(fitting: textWidth)
                let bodySize = body.size(fitting: textWidth)
                let column = titleSize.height + M.offlineTitleMarginBottom + bodySize.height
                let height = 2 * M.offlinePaddingVertical + max(M.offlineIconSize, column)
                let top = M.offlinePaddingVertical
                frame = RowFrame(
                    frame: CGRect(x: 0, y: y, width: rowWidth, height: height),
                    icon: CGRect(x: M.offlinePaddingHorizontal, y: top, width: M.offlineIconSize, height: M.offlineIconSize),
                    label: CGRect(x: textX, y: top, width: titleSize.width, height: titleSize.height),
                    chevron: nil,
                    body: CGRect(x: textX, y: top + titleSize.height + M.offlineTitleMarginBottom, width: bodySize.width, height: bodySize.height)
                )
            }
            rows.append(frame)
            y += frame.frame.height
        }
        configHeight = y + M.configPaddingBottom

        // The rows hang from the bottom of content at least as tall as the
        // scroll view.
        let needed = M.configPaddingTop + configHeight + M.scrollPaddingBottom
        let contentHeight = max(scroll.height, needed)
        contentSize = CGSize(width: width, height: contentHeight)
        let rowsTop = contentHeight - M.scrollPaddingBottom - configHeight
        let rowsX = laneX + M.configPaddingHorizontal
        self.rows = rows.map { row in
            var row = row
            row.frame = row.frame.offsetBy(dx: rowsX, dy: rowsTop)
            return row
        }
    }
}

/// The composer on a phone (`mobileInputBox`): the prompt over a row of
/// the harness, settings, the microphone and Send, in liquid glass.
///
///     ╭ |8+10| Ask claude code ………………………………… |6+6| ╮   44 at least
///     │ |8| (◎ claude code ⌄)|2|(⚙) ……… (🎙)|2|(↑) |6| │   40
///     ╰──────────────────────────────────────────────╯   98 at least
public struct NewSessionComposerLayout: Equatable, Sendable {
    public enum Metrics {
        public static let minHeight: CGFloat = 98
        public static let radius: CGFloat = 26
        public static let paddingVertical: CGFloat = 6
        public static let paddingLeft: CGFloat = 8
        public static let paddingRight: CGFloat = 6
        /// `mobileInputField`.
        public static let fieldMinHeight: CGFloat = 44
        public static let fieldPaddingLeft: CGFloat = 10
        public static let fieldPaddingRight: CGFloat = 6
        /// MultiTextInput: one 22pt line, up to 120 (`COMPACT_COMPOSER_INPUT_MAX_HEIGHT`).
        public static let lineHeight: CGFloat = 22
        public static let inputMaxHeight: CGFloat = 120
        /// `mobileActionButtonsContainer`.
        public static let actionRowMinHeight: CGFloat = 40
        public static let actionGap: CGFloat = 2
        /// `composerAgentButton`.
        public static let agentHeight: CGFloat = 36
        public static let agentMaxWidth: CGFloat = 132
        public static let agentPaddingHorizontal: CGFloat = 9
        public static let agentGap: CGFloat = 6
        public static let agentIconSize: CGFloat = 14
        public static let agentChevronSize: CGFloat = 12
        /// `composerActionButton` and `mobileSendButton`.
        public static let controlSize: CGFloat = 38
        public static let settingsIconSize: CGFloat = 18
        public static let micIconSize: CGFloat = 21
        public static let sendIconSize: CGFloat = 18
    }

    public struct Input {
        public var width: CGFloat
        /// One device pixel: the glass's border.
        public var hairline: CGFloat
        /// The text's own height at the input's width.
        public var textHeight: CGFloat
        public var agentLabel: Measurable
        public var showsSettings: Bool
        /// The prompt's line at the text size: 22 × RN's multiplier. The
        /// text is never shorter; the 44 field and the 120 cap stay.
        public var lineHeight: CGFloat

        public init(width: CGFloat, hairline: CGFloat, textHeight: CGFloat, agentLabel: Measurable, showsSettings: Bool, lineHeight: CGFloat = Metrics.lineHeight) {
            self.width = width
            self.hairline = hairline
            self.textHeight = textHeight
            self.agentLabel = agentLabel
            self.showsSettings = showsSettings
            self.lineHeight = lineHeight
        }
    }

    public var size: CGSize
    /// The text view.
    public var input: CGRect
    /// The text outgrew 120pt and scrolls.
    public var textScrolls: Bool
    public var actionRow: CGRect
    public var agent: CGRect
    /// Inside `agent`.
    public var agentIcon: CGRect
    public var agentLabel: CGRect
    public var agentChevron: CGRect
    public var settings: CGRect?
    public var mic: CGRect
    public var send: CGRect

    public init(_ input: Input) {
        typealias M = Metrics
        let border = input.hairline
        let width = max(0, input.width)
        let contentX = border + M.paddingLeft
        let contentWidth = max(0, width - 2 * border - M.paddingLeft - M.paddingRight)

        let textHeight = min(M.inputMaxHeight, max(input.lineHeight, input.textHeight))
        textScrolls = input.textHeight > M.inputMaxHeight
        let fieldY = border + M.paddingVertical
        let fieldHeight = max(M.fieldMinHeight, textHeight)
        // Centred to the pixel above, so the input, whose height is on the
        // pixel grid, keeps it when its frame is snapped; centred exactly,
        // a scaled line (37 at XS in the 44) starts on half a pixel and
        // snaps a pixel taller or shorter than its text.
        let slack = (fieldHeight - textHeight) / 2
        self.input = CGRect(
            x: contentX + M.fieldPaddingLeft,
            y: fieldY + (border > 0 ? (slack / border + 0.001).rounded(.down) * border : slack),
            width: max(0, contentWidth - M.fieldPaddingLeft - M.fieldPaddingRight),
            height: textHeight
        )

        let rowY = fieldY + fieldHeight
        let rowHeight = max(M.actionRowMinHeight, M.controlSize)
        actionRow = CGRect(x: contentX, y: rowY, width: contentWidth, height: rowHeight)
        send = CGRect(x: contentX + contentWidth - M.controlSize, y: rowY + (rowHeight - M.controlSize) / 2, width: M.controlSize, height: M.controlSize)
        mic = send.offsetBy(dx: -(M.controlSize + M.actionGap), dy: 0)
        let leftWidth = max(0, mic.minX - M.actionGap - contentX)

        let chrome = 2 * M.agentPaddingHorizontal + M.agentIconSize + M.agentChevronSize + 2 * M.agentGap
        let agentLimit = min(M.agentMaxWidth, leftWidth)
        // One line that shrinks to fit (`numberOfLines={1}`, `flexShrink: 1`).
        let labelRoom = max(0, agentLimit - chrome)
        let label = input.agentLabel.size(fitting: labelRoom)
        let labelWidth = min(label.width, labelRoom)
        agent = CGRect(x: contentX, y: rowY + (rowHeight - M.agentHeight) / 2, width: chrome + labelWidth, height: M.agentHeight)
        let mid = M.agentHeight / 2
        agentIcon = CGRect(x: M.agentPaddingHorizontal, y: mid - M.agentIconSize / 2, width: M.agentIconSize, height: M.agentIconSize)
        agentLabel = CGRect(x: agentIcon.maxX + M.agentGap, y: mid - label.height / 2, width: labelWidth, height: label.height)
        agentChevron = CGRect(x: agentLabel.maxX + M.agentGap, y: mid - M.agentChevronSize / 2, width: M.agentChevronSize, height: M.agentChevronSize)
        // The left group clips what doesn't fit (`overflow: 'hidden'`).
        let settingsX = agent.maxX + M.actionGap
        settings = input.showsSettings && settingsX + M.controlSize <= contentX + leftWidth
            ? CGRect(x: settingsX, y: rowY + (rowHeight - M.controlSize) / 2, width: M.controlSize, height: M.controlSize)
            : nil

        let height = max(M.minHeight, rowY + rowHeight + M.paddingVertical + border)
        size = CGSize(width: width, height: height)
    }
}

/// The glass popover a picker opens in (`nativePickerViewportPopover`):
/// 20pt in from each side, above the row or the composer that opened it,
/// never above the header.
public struct NewSessionPickerLayout: Equatable, Sendable {
    public enum Metrics {
        public static let inset: CGFloat = 20
        public static let radius: CGFloat = 24
        public static let paddingHorizontal: CGFloat = 12
        public static let paddingVertical: CGFloat = 10
        public static let maxHeight: CGFloat = 264
        /// Room kept under the header.
        public static let headerGap: CGFloat = 12
        /// Above the composer, for the harness and settings pickers.
        public static let composerGap: CGFloat = 10
        /// Above the row, for the place pickers.
        public static let rowGap: CGFloat = 8
        /// `NATIVE_PICKER_TOP`, less the first row's: each place row is
        /// taken to be 48 tall.
        public static let rowStep: CGFloat = 48
        /// LocalBlurHalo: blurred 35pt past the popover and feathered.
        public static let haloExpansion: CGFloat = 35
        public static let haloFeather: CGFloat = 18.9
        /// AnimatedPopup: in from 0.96 and 8pt lower over 190ms.
        public static let enterScale: CGFloat = 0.96
        public static let enterOffset: CGFloat = 8
        public static let enterDuration: Double = 0.19
    }

    /// What opened the popover.
    public enum Anchor: Equatable, Sendable {
        /// The harness button or the settings gear.
        case composer
        /// A place row: 0 the machine, 1 the path, 2 the worktree.
        case row(Int)
    }

    public struct Input {
        public var size: CGSize
        public var safeTop: CGFloat
        public var safeBottom: CGFloat
        public var composerHeight: CGFloat
        /// `mobileConfigHeight`.
        public var configHeight: CGFloat
        public var anchor: Anchor
        /// The popover's content, before its padding.
        public var contentHeight: CGFloat

        public init(size: CGSize, safeTop: CGFloat, safeBottom: CGFloat, composerHeight: CGFloat, configHeight: CGFloat, anchor: Anchor, contentHeight: CGFloat) {
            self.size = size
            self.safeTop = safeTop
            self.safeBottom = safeBottom
            self.composerHeight = composerHeight
            self.configHeight = configHeight
            self.anchor = anchor
            self.contentHeight = contentHeight
        }
    }

    public var frame: CGRect
    /// Inside `frame`.
    public var content: CGRect

    public init(_ input: Input) {
        typealias M = Metrics
        let height = min(M.maxHeight, input.contentHeight + 2 * M.paddingVertical)
        let headerBottom = input.safeTop + NewSessionScreenLayout.Metrics.headerHeight
        // Measured against the window, not the keyboard: pickers open with
        // the keyboard down.
        let composerTop = input.size.height - input.safeBottom - input.composerHeight
        let top: CGFloat
        switch input.anchor {
        case .composer:
            top = max(headerBottom + M.headerGap, composerTop - height - M.composerGap)
        case .row(let index):
            let configTop = composerTop - NewSessionScreenLayout.Metrics.scrollPaddingBottom - input.configHeight
            let rowTop = configTop + CGFloat(index) * M.rowStep
            top = max(headerBottom + M.headerGap, rowTop - height - M.rowGap)
        }
        let width = max(0, input.size.width - 2 * M.inset)
        frame = CGRect(x: M.inset, y: top, width: width, height: height)
        content = CGRect(x: M.paddingHorizontal, y: M.paddingVertical, width: max(0, width - 2 * M.paddingHorizontal), height: max(0, height - 2 * M.paddingVertical))
    }
}

/// A picker's rows inside the popover: `PickerContent`, `PathPickerContent`
/// and the composer's settings pages, embedded. Some rows stay put above a
/// list that scrolls past 176pt.
public struct NewSessionPickerContentLayout: Equatable, Sendable {
    public enum Metrics {
        /// `embeddedOptionList`.
        public static let listMaxHeight: CGFloat = 176
        /// `embeddedOption`.
        public static let optionPaddingVertical: CGFloat = 8
        public static let optionPaddingHorizontal: CGFloat = 4
        public static let optionGap: CGFloat = 12
        /// `embeddedSearchRow`.
        public static let searchPaddingVertical: CGFloat = 8
        public static let searchPaddingHorizontal: CGFloat = 4
        public static let searchGap: CGFloat = 10
        public static let searchMarginBottom: CGFloat = 4
        public static let searchIconSize: CGFloat = 16
        /// `embeddedPathInputRow`.
        public static let pathMinHeight: CGFloat = 38
        public static let pathFieldMinHeight: CGFloat = 34
        /// `sectionLabel` and `pathMetaText`.
        public static let textPaddingHorizontal: CGFloat = 4
        public static let textPaddingBottom: CGFloat = 8
        /// `divider`.
        public static let dividerMarginHorizontal: CGFloat = 12
        public static let dividerMarginVertical: CGFloat = 4
        /// `emptyText`.
        public static let emptyPaddingVertical: CGFloat = 20
        /// `composerPickerHeader`.
        public static let backMinHeight: CGFloat = 40
        public static let backButtonSize: CGFloat = 36
        public static let backIconSize: CGFloat = 20
        public static let backGap: CGFloat = 4
        public static let backPaddingBottom: CGFloat = 4
        /// The containers' padding: `embeddedContainer` and the settings
        /// page's `composerSettingsContainer`.
        public static let embeddedPaddingBottom: CGFloat = 2
        public static let settingsPaddingTop: CGFloat = 4
        public static let settingsPaddingBottom: CGFloat = 8
    }

    public enum Element {
        /// The search field: a 16pt glyph and a one-line field.
        case search(fieldHeight: CGFloat)
        /// The path field (`pathInputRow`).
        case pathField(fieldHeight: CGFloat)
        /// A section heading or a line of meta text.
        case text(Measurable)
        /// A row: a glyph, a label (with a line under it) and maybe a
        /// trailing glyph.
        case option(icon: CGFloat, label: Measurable, detail: Measurable?, trailing: CGFloat?)
        case divider
        /// "no results", centred.
        case empty(Measurable)
        /// A settings page's back button and title.
        case back(title: Measurable)
    }

    public struct Input {
        public var width: CGFloat
        /// Rows above the list, which never scroll.
        public var header: [Element]
        public var list: [Element]
        /// Nil for a list that never scrolls (the settings page).
        public var listMaxHeight: CGFloat?
        public var paddingTop: CGFloat
        public var paddingBottom: CGFloat

        public init(width: CGFloat, header: [Element] = [], list: [Element], listMaxHeight: CGFloat? = Metrics.listMaxHeight, paddingTop: CGFloat = 0, paddingBottom: CGFloat = Metrics.embeddedPaddingBottom) {
            self.width = width
            self.header = header
            self.list = list
            self.listMaxHeight = listMaxHeight
            self.paddingTop = paddingTop
            self.paddingBottom = paddingBottom
        }
    }

    public struct ElementFrame: Equatable, Sendable {
        /// In the content for header rows, in the list for list rows.
        public var frame: CGRect
        /// The rest are inside `frame`.
        public var icon: CGRect?
        /// The label, the field, the heading or the title.
        public var label: CGRect?
        public var detail: CGRect?
        public var trailing: CGRect?
    }

    public var header: [ElementFrame]
    /// The list's viewport, in the content.
    public var listFrame: CGRect
    public var listContentHeight: CGFloat
    public var list: [ElementFrame]
    /// The content's height, padding included.
    public var height: CGFloat

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.width)
        var y = input.paddingTop
        var header: [ElementFrame] = []
        for element in input.header {
            let frame = Self.place(element, y: y, width: width)
            header.append(frame.frame)
            y += frame.advance
        }
        self.header = header

        var listY: CGFloat = 0
        var list: [ElementFrame] = []
        for element in input.list {
            let frame = Self.place(element, y: listY, width: width)
            list.append(frame.frame)
            listY += frame.advance
        }
        self.list = list
        listContentHeight = listY
        let viewport = input.listMaxHeight.map { min($0, listY) } ?? listY
        listFrame = CGRect(x: 0, y: y, width: width, height: viewport)
        height = y + viewport + input.paddingBottom
    }

    /// A row's frames and how far down the next one starts.
    private static func place(_ element: Element, y: CGFloat, width: CGFloat) -> (frame: ElementFrame, advance: CGFloat) {
        typealias M = Metrics
        switch element {
        case .search(let fieldHeight):
            let height = 2 * M.searchPaddingVertical + max(M.searchIconSize, fieldHeight)
            let fieldX = M.searchPaddingHorizontal + M.searchIconSize + M.searchGap
            return (ElementFrame(
                frame: CGRect(x: 0, y: y, width: width, height: height),
                icon: CGRect(x: M.searchPaddingHorizontal, y: (height - M.searchIconSize) / 2, width: M.searchIconSize, height: M.searchIconSize),
                label: CGRect(x: fieldX, y: (height - fieldHeight) / 2, width: max(0, width - fieldX - M.searchPaddingHorizontal), height: fieldHeight)
            ), height + M.searchMarginBottom)
        case .pathField(let fieldHeight):
            let field = max(M.pathFieldMinHeight, fieldHeight)
            let height = max(M.pathMinHeight, field, M.searchIconSize)
            let fieldX = M.searchPaddingHorizontal + M.searchIconSize + M.searchGap
            return (ElementFrame(
                frame: CGRect(x: 0, y: y, width: width, height: height),
                icon: CGRect(x: M.searchPaddingHorizontal, y: (height - M.searchIconSize) / 2, width: M.searchIconSize, height: M.searchIconSize),
                label: CGRect(x: fieldX, y: (height - field) / 2, width: max(0, width - fieldX - M.searchPaddingHorizontal), height: field)
            ), height + M.searchMarginBottom)
        case .text(let text):
            let size = text.size(fitting: max(0, width - 2 * M.textPaddingHorizontal))
            let height = size.height + M.textPaddingBottom
            return (ElementFrame(
                frame: CGRect(x: 0, y: y, width: width, height: height),
                label: CGRect(x: M.textPaddingHorizontal, y: 0, width: size.width, height: size.height)
            ), height)
        case .option(let icon, let label, let detail, let trailing):
            let textX = M.optionPaddingHorizontal + icon + M.optionGap
            let trailingRoom = trailing.map { $0 + M.optionGap } ?? 0
            let textWidth = max(0, width - textX - M.optionPaddingHorizontal - trailingRoom)
            let labelSize = label.size(fitting: textWidth)
            let detailSize = detail?.size(fitting: textWidth)
            let column = labelSize.height + (detailSize?.height ?? 0)
            let height = 2 * M.optionPaddingVertical + max(icon, column, trailing ?? 0)
            let columnY = (height - column) / 2
            return (ElementFrame(
                frame: CGRect(x: 0, y: y, width: width, height: height),
                icon: CGRect(x: M.optionPaddingHorizontal, y: (height - icon) / 2, width: icon, height: icon),
                label: CGRect(x: textX, y: columnY, width: textWidth, height: labelSize.height),
                detail: detailSize.map { CGRect(x: textX, y: columnY + labelSize.height, width: textWidth, height: $0.height) },
                trailing: trailing.map { CGRect(x: width - M.optionPaddingHorizontal - $0, y: (height - $0) / 2, width: $0, height: $0) }
            ), height)
        case .divider:
            return (ElementFrame(
                frame: CGRect(x: M.dividerMarginHorizontal, y: y + M.dividerMarginVertical, width: max(0, width - 2 * M.dividerMarginHorizontal), height: 1)
            ), 1 + 2 * M.dividerMarginVertical)
        case .empty(let text):
            let size = text.size(fitting: width)
            let height = size.height + 2 * M.emptyPaddingVertical
            return (ElementFrame(
                frame: CGRect(x: 0, y: y, width: width, height: height),
                label: CGRect(x: (width - size.width) / 2, y: M.emptyPaddingVertical, width: size.width, height: size.height)
            ), height)
        case .back(let title):
            let titleX = M.backButtonSize + M.backGap
            let size = title.size(fitting: max(0, width - titleX))
            let row = max(M.backMinHeight, M.backButtonSize, size.height)
            return (ElementFrame(
                frame: CGRect(x: 0, y: y, width: width, height: row),
                icon: CGRect(x: 0, y: (row - M.backButtonSize) / 2, width: M.backButtonSize, height: M.backButtonSize),
                label: CGRect(x: titleX, y: (row - size.height) / 2, width: max(0, width - titleX), height: size.height)
            ), row + M.backPaddingBottom)
        }
    }
}
