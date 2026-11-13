import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The composer's "+" menu, measured as Telegram's attachment menu
/// (`AttachmentContainer`, `AttachmentController`, `AttachmentPanel`,
/// `MediaPickerScreen`, `MediaPickerPlaceholderNode`):
///
///     ╭───────────────────╮   a sheet over the dimmed chat, a quarter of
///     │(×)    Recents ⌄   │   the screen down; dragged up it fills the
///     │ ┌──┐ ▢ ▢           │   screen, dragged down it goes
///     │ │📷│ ▢ ▢           │   the camera two rows tall at the top left,
///     │ └──┘ ▢ ▢ ▢ ...     │   the library newest first around it
///     │    ( Gallery|Files )│   a glass tab bar 22 off the bottom, which
///     ╰───────────────────╯   turns into the caption and the picked
///                              count (✓ 3) at its end while photos are
///                              picked
///
/// On an iPad the menu is a 390 × 670 card over the "+" instead. Without
/// the library the gallery is an explanation with the system's picker
/// under it.
public enum AttachMenuMetrics {
    /// How far below its expanded top the sheet first rests, as a share of
    /// the screen's longer side (`attachmentDefaultTopInset`).
    public static let restFactor: CGFloat = 0.2488
    public static let narrowRestFactor: CGFloat = 0.15
    /// The expanded sheet's gap under the status bar.
    public static let topGap: CGFloat = 10
    public static let cornerRadius: CGFloat = 38
    /// At rest the sheet is drawn 5 in from each side, scaled about its
    /// middle; expanded it fills the width.
    public static let restInset: CGFloat = 5

    /// The iPad card, over the "+" (`containerLayoutUpdated`, regular width).
    public static let cardSize = CGSize(width: 390, height: 670)
    public static let cardTrailing: CGFloat = 28
    public static let cardBottom: CGFloat = 54
    public static let cardMargin: CGFloat = 16

    /// The header (`MediaPickerScreen`, glass): the grid runs under a 68
    /// tall glass bar (`defaultNavigationBarHeight` in a glass modal) with
    /// the close button 16 in from the corner, 44 round; the title on its
    /// middle, 12 clear of it.
    public static let headerHeight: CGFloat = 68
    public static let headerInset: CGFloat = 16
    public static let headerButton: CGFloat = 44
    public static let headerGap: CGFloat = 12
    /// The fade under the header over a scrolled grid: 80 tall, from 5
    /// scrolled; the title turns white from 30.
    public static let topEdge: CGFloat = 80
    public static let topEdgeFrom: CGFloat = 5
    public static let darkTitleFrom: CGFloat = 30

    /// The grid: three columns (five on a phone turned sideways), 1 apart.
    public static let spacing: CGFloat = 1
    public static let columns = 3
    public static let wideColumns = 5

    /// The glass tab bar: 62 tall, 22 off the bottom, 160 wide for two
    /// tabs of 72 that sit 82 apart, 3 in from its ends.
    public static let barHeight: CGFloat = 62
    public static let barBottom: CGFloat = 22
    public static let barInset: CGFloat = 3
    public static let tabWidth: CGFloat = 72
    public static let tabIcon: CGFloat = 30
    /// Two tabs keep three tabs' spacing; three are 240 wide, four 300.
    public static func barWidth(tabs: Int) -> CGFloat {
        switch tabs {
        case ...2: 160
        case 3: 240
        default: 300
        }
    }
    /// A tab: its 30 glyph 9 down (4 + a pixel, 5 more on glass), its
    /// name's top 15 and two pixels under the glyph's middle.
    public static let tabIconTop: CGFloat = 9
    public static let tabTitleGap: CGFloat = 15
    /// While photos are picked the bar is the caption: 28 in from the sides
    /// and the bottom (16 and 8 over the keyboard), 40 tall at least, its
    /// corners 20 at most; the tabs rise 11 as they fade.
    public static let captionSide: CGFloat = 28
    public static let captionFocusedSide: CGFloat = 16
    public static let captionBottom: CGFloat = 28
    public static let captionFocusedBottom: CGFloat = 8
    public static let captionHeight: CGFloat = 40
    public static let captionRadius: CGFloat = 20
    public static let captionTextInset: CGFloat = 16
    /// The caption's room above and below its text, together.
    public static let captionPadding: CGFloat = 19
    public static let tabsRise: CGFloat = 11
    /// The confirm at the caption's end, which takes the picks to the
    /// composer: a check 20 at 8 and the count from 30 on an accent
    /// capsule 34 tall, 12 past the count, 3 in from the field's end; it
    /// takes touches the field's height down and 8 more before it.
    public static let confirmHeight: CGFloat = 34
    public static let confirmInset: CGFloat = 3
    public static let confirmIcon: CGFloat = 20
    public static let confirmIconX: CGFloat = 8
    public static let confirmLabelX: CGFloat = 30
    public static let confirmTrailing: CGFloat = 12
    public static let confirmSlop: CGFloat = 8
    /// The capsule for a count `countWidth` wide.
    public static func confirmWidth(countWidth: CGFloat) -> CGFloat {
        confirmLabelX + ceil(countWidth) + confirmTrailing
    }
    /// What the caption's text keeps clear at its end for the confirm.
    public static func confirmReserve(countWidth: CGFloat) -> CGFloat {
        confirmWidth(countWidth: countWidth) + confirmInset + confirmSlop
    }
    /// Room the page keeps under its content for the bar.
    public static var barReserve: CGFloat { barBottom + barHeight + 8 }
}

/// Telegram's timings, as the UI animates them.
public enum AttachMenuMotion {
    /// In: 0.4 s on Display's `.spring` curve, which below 0.5 s is this
    /// cubic Bézier; the dim fades in over 0.3 s, linear.
    public static let openDuration: TimeInterval = 0.4
    public static let openCurve: (x1: Float, y1: Float, x2: Float, y2: Float) = (0.38, 0.7, 0.125, 1.0)
    public static let dimDuration: TimeInterval = 0.3
    /// The dim's black, and how much of it an iPad's card puts over the chat.
    public static let dimAlpha: CGFloat = 0.25
    public static let cardDimShare: CGFloat = 0.1
    /// Out: down past the screen in 0.25 s, ease in-out, the dim with it;
    /// the iPad's card fades over 0.3 s.
    public static let closeDuration: TimeInterval = 0.25
    public static let cardCloseDuration: TimeInterval = 0.3
    /// Settling after a drag: a spring of mass 5, stiffness 900 and
    /// damping 124 sped up to 0.45 s; returning where it was, 0.3 s ease in-out.
    public static let settleDuration: TimeInterval = 0.45
    public static let springMass: CGFloat = 5
    public static let springStiffness: CGFloat = 900
    public static let springDamping: CGFloat = 124
    public static let returnDuration: TimeInterval = 0.3
    /// The drop a drag leaves goes back over 0.3 s, ease in-out, beside
    /// the top's own settle.
    public static let dropReturnDuration: TimeInterval = 0.3
    /// A drag that sends the sheet away: damping 180, its velocity over
    /// the screen below the sheet's top (`interactivelyDismissed`).
    public static let dismissDamping: CGFloat = 180
    /// Typing a caption expands the sheet over 0.5 s on the `.spring` curve.
    public static let captionExpandDuration: TimeInterval = 0.5

    /// Glass, in from the "+" (`AttachmentController.animateIn`, glass):
    /// the sheet grows out of the button's circle. Its centre travels on a
    /// 0.4 s spring (damping 110, initial velocity 1.1), its size and
    /// scale on a 0.45 s one (damping 110), its corners from round to 38
    /// over 0.2 s; its page fades in over 0.2 s while the "+" glyph on the
    /// growing glass fades in 0.15.
    public enum Morph {
        public static let positionDuration: TimeInterval = 0.4
        public static let positionDamping: CGFloat = 110
        public static let positionVelocity: CGFloat = 1.1
        public static let scaleDuration: TimeInterval = 0.45
        public static let scaleDamping: CGFloat = 110
        public static let cornersDuration: TimeInterval = 0.2
        public static let contentFadeIn: TimeInterval = 0.2
        public static let glyphFade: TimeInterval = 0.15
        /// Out, into the "+" (`animateOut`, glass): the centre on a 0.4 s
        /// spring (damping 110), size and scale 0.3 s and corners 0.2 s
        /// (damping 124), all with the drag's velocity; the page fades in
        /// 0.12 s, the glass after 0.2 s over 0.15, the glyph comes back in 0.22.
        public static let outScaleDuration: TimeInterval = 0.3
        public static let outDamping: CGFloat = 124
        public static let contentFadeOut: TimeInterval = 0.12
        public static let glassFadeDelay: TimeInterval = 0.2
        public static let glassFade: TimeInterval = 0.15
        public static let outGlyphFade: TimeInterval = 0.22
        /// The grown sheet's bottom corners: the screen's, less 2, at least 22.
        public static func bottomRadius(screen: CGFloat) -> CGFloat { max(24, screen) - 2 }
    }

    /// Switching tabs: the old page fades over 0.23 s while the sheet dips
    /// 10 in 0.2 s and springs back (damping 70) in 0.3.
    public static let switchFade: TimeInterval = 0.23
    public static let switchDip: CGFloat = 10
    public static let switchDipDuration: TimeInterval = 0.2
    public static let switchReturnDuration: TimeInterval = 0.3
    public static let switchReturnDamping: CGFloat = 70
    /// The bar turning into "Add N" and back.
    public static let barDuration: TimeInterval = 0.4
}

/// Where the sheet is, in the window's space, for any top edge.
public struct AttachMenuSheetLayout: Equatable, Sendable {
    public enum Style: Equatable, Sendable {
        /// A phone upright: rests a quarter down, drags to expand.
        case sheet
        /// A phone sideways: the whole screen, square cornered.
        case fullScreen
        /// An iPad: a card over the "+".
        case card
    }

    public struct Placement: Equatable, Sendable {
        /// The rounded clip before its scale: from the sheet's top to the
        /// screen's bottom (the card's own frame on an iPad).
        public var clip: CGRect
        public var scale: CGFloat
        /// The content in the clip's space; its size never changes while
        /// the sheet moves, so moving it lays nothing out.
        public var content: CGRect
        /// How much of the content is below the screen.
        public var hidden: CGFloat
        /// The bar's bottom edge, in the window's space.
        public var barBottom: CGFloat
    }

    public var style: Style
    public var size: CGSize
    public var expandedTop: CGFloat
    /// The sheet's top at rest.
    public var restTop: CGFloat
    public var cornerRadius: CGFloat
    /// The card on an iPad.
    public var card: CGRect?
    /// The content's size.
    public var content: CGSize
    /// The content's insets from the window's sides (the notch, sideways).
    public var sides: LayoutInsets

    /// `source` is the "+", for the iPad's card.
    public init(size: CGSize, safeArea: LayoutInsets, regular: Bool, source: CGRect? = nil) {
        typealias M = AttachMenuMetrics
        self.size = size
        let width = max(0, size.width)
        let height = max(0, size.height)
        if regular {
            style = .card
            let cardWidth = min(M.cardSize.width, max(0, width - 2 * M.cardMargin))
            let available = max(0, height - safeArea.top - safeArea.bottom - 2 * M.cardMargin)
            let cardHeight = min(M.cardSize.height, available)
            let bottom = height - cardHeight - safeArea.bottom - M.cardBottom
            var x = width - cardWidth - M.cardTrailing
            var y = bottom
            if let source {
                x = min(x, floor(source.midX - cardWidth / 2) - 2)
                y = min(bottom, source.minY - cardHeight)
            }
            x = max(safeArea.left + M.cardMargin, x)
            y = max(safeArea.top + M.cardMargin, y)
            let frame = CGRect(x: x, y: y, width: cardWidth, height: cardHeight)
            card = frame
            expandedTop = frame.minY
            restTop = frame.minY
            cornerRadius = M.cornerRadius
            content = frame.size
            sides = .zero
        } else if width > height {
            style = .fullScreen
            card = nil
            expandedTop = 0
            restTop = 0
            cornerRadius = 0
            content = CGSize(width: width, height: height)
            sides = LayoutInsets(left: safeArea.left, right: safeArea.right)
        } else {
            style = .sheet
            card = nil
            expandedTop = safeArea.top + M.topGap
            let factor = width <= 320 ? M.narrowRestFactor : M.restFactor
            restTop = expandedTop + floor(max(width, height) * factor)
            cornerRadius = M.cornerRadius
            content = CGSize(width: width, height: max(0, height - expandedTop))
            sides = .zero
        }
    }

    /// How far the sheet travels between rest and expanded.
    public var travel: CGFloat { restTop - expandedTop }

    /// The sheet can rest lower than expanded and be dragged between.
    public var canCollapse: Bool { travel > 0 }

    public func top(expanded: Bool) -> CGFloat { expanded ? expandedTop : restTop }

    /// The sheet with its top at `top`, `drop` lower again (dragged down
    /// past rest, or on its way in or out).
    public func placement(top: CGFloat, drop: CGFloat = 0) -> Placement {
        typealias M = AttachMenuMetrics
        if let card {
            return Placement(clip: card.offsetBy(dx: 0, dy: drop), scale: 1, content: CGRect(origin: .zero, size: content), hidden: 0, barBottom: card.maxY + drop)
        }
        let top = max(expandedTop, top)
        let progress = travel > 0 ? min(1, max(0, (top - expandedTop) / travel)) : 0
        let width = size.width
        let scale = style == .sheet && width > 0 ? 1 - 2 * M.restInset / width * progress : 1
        return Placement(
            clip: CGRect(x: 0, y: top + drop, width: width, height: max(0, size.height - top)),
            scale: scale,
            content: CGRect(origin: .zero, size: content),
            hidden: top - expandedTop,
            barBottom: size.height + drop
        )
    }
}

/// The library grid, Telegram's: the camera two cells tall at the top
/// left when there is one, the pictures filling the cells around and under
/// it. Frames are in the grid's content space, under `top` (the limited
/// access note).
public struct AttachMenuGridLayout: Equatable, Sendable {
    public var columns: Int
    public var cell: CGSize
    public var camera: CGRect?
    public var top: CGFloat
    public var count: Int
    public var contentHeight: CGFloat
    private var width: CGFloat
    private var left: CGFloat

    /// `left` and `right` keep the cells off the notch's sides; `pixel` is
    /// one device pixel, for the cells' width.
    public init(width: CGFloat, left: CGFloat = 0, right: CGFloat = 0, wide: Bool, pixel: CGFloat, count: Int, camera: Bool, top: CGFloat) {
        typealias M = AttachMenuMetrics
        columns = wide ? M.wideColumns : M.columns
        let inner = max(0, width - left - right)
        let n = CGFloat(columns)
        let pixel = max(pixel, 0.0001)
        let side = max(0, floor((inner - M.spacing * (n - 1)) / n / pixel) * pixel)
        cell = CGSize(width: side, height: side)
        self.width = inner
        self.left = left
        self.top = top
        self.count = max(0, count)
        self.camera = camera ? CGRect(x: left, y: top, width: side, height: 2 * side + M.spacing) : nil
        contentHeight = 0
        contentHeight = height()
    }

    /// The same grid holding `count` pictures, as a batch of library
    /// changes leaves it before the sheet lays it out again.
    public func with(count: Int) -> AttachMenuGridLayout {
        var copy = self
        copy.count = max(0, count)
        copy.contentHeight = copy.height()
        return copy
    }

    private func height() -> CGFloat {
        let cells = count + (camera != nil ? 2 : 0)
        let rows = max(camera != nil ? 2 : 0, (cells + columns - 1) / columns)
        return top + CGFloat(rows) * cell.height + CGFloat(max(0, rows - 1)) * AttachMenuMetrics.spacing
    }

    /// The cell holding picture `index`: row and column.
    private func position(_ index: Int) -> (row: Int, column: Int) {
        if camera != nil, columns > 1, index < 2 * (columns - 1) {
            return (index / (columns - 1), 1 + index % (columns - 1))
        }
        let slot = index + (camera != nil ? 2 : 0)
        return (slot / columns, slot % columns)
    }

    /// Where picture `index` sits; the last column takes whatever width
    /// the rounding left.
    public func frame(at index: Int) -> CGRect {
        let (row, column) = position(index)
        let x = column == columns - 1 ? left + width - cell.width : left + CGFloat(column) * (cell.width + AttachMenuMetrics.spacing)
        return CGRect(x: x, y: top + CGFloat(row) * (cell.height + AttachMenuMetrics.spacing), width: cell.width, height: cell.height)
    }

    /// The first picture in `row`.
    private func first(inRow row: Int) -> Int {
        if camera != nil {
            return row < 2 ? row * (columns - 1) : row * columns - 2
        }
        return row * columns
    }

    /// The pictures showing between `minY` and `maxY` of the content.
    public func visible(minY: CGFloat, maxY: CGFloat) -> Range<Int> {
        let pitch = cell.height + AttachMenuMetrics.spacing
        guard pitch > 0, count > 0, maxY >= minY else { return 0..<0 }
        let firstRow = max(0, Int(floor((minY - top) / pitch)))
        let lastRow = max(0, Int(floor((maxY - top) / pitch)))
        let lower = min(count, first(inRow: firstRow))
        let upper = min(count, max(lower, first(inRow: lastRow + 1)))
        return lower..<upper
    }
}

/// The glass panel at the sheet's foot (`AttachmentPanel`, glass), in the
/// window's space: the tab bar with its lens, or while photos are picked
/// the caption field with the confirm, which the same glass becomes.
public struct AttachMenuPanelLayout: Equatable, Sendable {
    public struct Tab: Equatable, Sendable {
        /// In the tab bar's space.
        public var frame: CGRect
        public var icon: CGRect
        public var title: CGRect
    }

    /// The tab bar, where it rests (it rises 11 as the caption takes over).
    public var tabBar: CGRect
    public var tabs: [Tab]
    /// The chosen tab's lens, in the tab bar's space.
    public var lens: CGRect
    /// The glass: the tab bar, or the caption.
    public var glass: CGRect
    public var glassRadius: CGFloat
    /// The tabs' offset: up 11 while picking.
    public var tabsOffset: CGFloat
    /// The caption's parts, in the glass's space: the text, its
    /// placeholder, and the confirm's touch and its capsule; the check
    /// and the count in the capsule's own space.
    public var text: CGRect
    public var placeholder: CGRect
    public var confirm: CGRect
    public var confirmBackground: CGRect
    public var confirmIcon: CGRect
    public var confirmLabel: CGRect

    public struct Input: Equatable, Sendable {
        public var minX: CGFloat
        public var width: CGFloat
        /// The sheet's bottom edge, or with the keyboard up its top.
        public var bottom: CGFloat
        public var sides: LayoutInsets
        /// The tabs' names measured.
        public var titles: [CGSize]
        public var selected: Int
        public var picking: Bool
        /// The caption has the keyboard.
        public var focused: Bool
        /// The caption's text measured at `textWidth(...)`, and its placeholder.
        public var textHeight: CGFloat
        public var placeholder: CGSize
        public var empty: Bool
        /// The tallest the caption grows.
        public var maxHeight: CGFloat
        /// The confirm's count measured.
        public var count: CGSize
        public var pixel: CGFloat

        public init(minX: CGFloat, width: CGFloat, bottom: CGFloat, sides: LayoutInsets = .zero, titles: [CGSize], selected: Int, picking: Bool, focused: Bool = false, textHeight: CGFloat = 0, placeholder: CGSize = .zero, empty: Bool = true, maxHeight: CGFloat = .greatestFiniteMagnitude, count: CGSize = .zero, pixel: CGFloat) {
            self.minX = minX
            self.width = width
            self.bottom = bottom
            self.sides = sides
            self.titles = titles
            self.selected = selected
            self.picking = picking
            self.focused = focused
            self.textHeight = textHeight
            self.placeholder = placeholder
            self.empty = empty
            self.maxHeight = maxHeight
            self.count = count
            self.pixel = pixel
        }
    }

    /// How wide the caption's text runs, for measuring it; `countWidth`
    /// the confirm's count.
    public static func textWidth(width: CGFloat, sides: LayoutInsets, focused: Bool, countWidth: CGFloat) -> CGFloat {
        typealias M = AttachMenuMetrics
        let side = focused ? M.captionFocusedSide : M.captionSide
        return max(0, width - sides.left - sides.right - 2 * side - M.captionTextInset - M.confirmReserve(countWidth: countWidth))
    }

    public init(_ input: Input) {
        typealias M = AttachMenuMetrics
        let pixel = max(input.pixel, 0.0001)
        let inner = max(0, input.width - input.sides.left - input.sides.right)
        let barWidth = min(M.barWidth(tabs: input.titles.count), max(0, inner - 2 * M.barBottom))
        tabBar = CGRect(x: input.minX + input.sides.left + floor((inner - barWidth) / 2 / pixel) * pixel, y: input.bottom - M.barBottom - M.barHeight, width: barWidth, height: M.barHeight)
        // `AttachmentPanel.updateViews`, glass: tabs `tabWidth` wide spread
        // over the bar less 3 each end, from the first's middle.
        let count = input.titles.count
        let pitch = count > 1 ? floor((barWidth - 2 * M.barInset - M.tabWidth) / CGFloat(count - 1) / pixel) * pixel : 0
        let iconTop = M.tabIconTop + pixel
        tabs = input.titles.enumerated().map { index, title in
            let frame = CGRect(x: M.barInset + CGFloat(index) * pitch, y: 0, width: M.tabWidth, height: M.barHeight)
            let icon = CGRect(x: frame.minX + floor((M.tabWidth - M.tabIcon) / 2 / pixel) * pixel, y: iconTop, width: M.tabIcon, height: M.tabIcon)
            let titleWidth = min(ceil(title.width), M.tabWidth)
            let titleHeight = ceil(title.height)
            return Tab(frame: frame, icon: icon, title: CGRect(x: frame.minX + floor((M.tabWidth - titleWidth) / 2 / pixel) * pixel, y: icon.midY + M.tabTitleGap + 2 * pixel, width: titleWidth, height: titleHeight))
        }
        let chosen = tabs.indices.contains(input.selected) ? tabs[input.selected].frame : .zero
        lens = CGRect(x: chosen.minX, y: M.barInset, width: chosen.width, height: M.barHeight - 2 * M.barInset)

        let side = input.focused ? M.captionFocusedSide : M.captionSide
        let spacing = input.focused ? M.captionFocusedBottom : M.captionBottom
        let fieldWidth = max(0, inner - 2 * side)
        let height = min(max(M.captionHeight, ceil(input.textHeight) + M.captionPadding), max(M.captionHeight, input.maxHeight))
        let field = CGRect(x: input.minX + input.sides.left + side, y: input.bottom - spacing - height, width: fieldWidth, height: height)
        let reserve = M.confirmReserve(countWidth: input.count.width)
        let textWidth = max(0, fieldWidth - M.captionTextInset - reserve)
        // At its tallest the text stops growing and scrolls inside, keeping
        // the same room above and below it.
        let textBox = min(ceil(input.textHeight), height - M.captionPadding)
        text = CGRect(x: M.captionTextInset, y: floor((height - textBox) / 2 / pixel) * pixel, width: textWidth, height: textBox)
        // The far end of the field, its foot on the last line as the text grows.
        confirm = CGRect(x: max(0, fieldWidth - reserve), y: 0, width: min(fieldWidth, reserve), height: height)
        let pill = CGSize(width: M.confirmWidth(countWidth: input.count.width), height: M.confirmHeight)
        confirmBackground = CGRect(x: fieldWidth - M.confirmInset - pill.width, y: height - floor((M.captionHeight + pill.height) / 2), width: pill.width, height: pill.height)
        confirmIcon = CGRect(x: M.confirmIconX, y: floor((pill.height - M.confirmIcon) / 2), width: M.confirmIcon, height: M.confirmIcon)
        let countHeight = ceil(input.count.height)
        confirmLabel = CGRect(x: M.confirmLabelX, y: floor((pill.height - countHeight) / 2 / pixel) * pixel, width: ceil(input.count.width), height: countHeight)
        let placeholderWidth = min(ceil(input.placeholder.width), textWidth)
        let placeholderHeight = ceil(input.placeholder.height)
        // Unfocused and empty, "Add a caption…" sits in the field's middle.
        let placeholderX = input.focused || !input.empty ? M.captionTextInset : floor((fieldWidth - placeholderWidth) / 2 / pixel) * pixel
        placeholder = CGRect(x: placeholderX, y: floor((M.captionHeight - placeholderHeight) / 2 / pixel) * pixel + height - M.captionHeight, width: placeholderWidth, height: placeholderHeight)

        if input.picking {
            glass = field
            glassRadius = min(M.captionRadius, height / 2)
            tabsOffset = -M.tabsRise
        } else {
            glass = tabBar
            glassRadius = M.barHeight / 2
            tabsOffset = 0
        }
    }
}

/// The header over the grid (`MediaPickerScreen`'s glass controls and
/// `MediaPickerTitleView`), in the content's space: close at the top left,
/// the title and its album arrow centred. The picked count isn't here: it
/// is the caption's confirm (`AttachMenuPanelLayout`).
public struct AttachMenuHeaderLayout: Equatable, Sendable {
    public var close: CGRect
    public var title: CGRect
    public var arrow: CGRect?
    /// The fade over a scrolled grid.
    public var edge: CGRect

    public static let arrow = CGSize(width: 24, height: 24)

    /// `arrow` is whether the title opens the albums.
    public init(width: CGFloat, sides: LayoutInsets = .zero, title: CGSize, arrow hasArrow: Bool, pixel: CGFloat) {
        typealias M = AttachMenuMetrics
        let pixel = max(pixel, 0.0001)
        let left = sides.left + M.headerInset
        close = CGRect(x: left, y: M.headerInset, width: M.headerButton, height: M.headerButton)
        // `MediaPickerTitleView`, glass: the title and the arrow 1 after it,
        // centred together, 1 up; the arrow on the title's middle.
        let titleSize = CGSize(width: ceil(title.width), height: ceil(title.height))
        let total = titleSize.width + (hasArrow ? 1 + Self.arrow.width : 0)
        let room = max(0, width - 2 * (close.maxX + M.headerGap))
        let titleWidth = min(titleSize.width, max(0, room - (hasArrow ? 1 + Self.arrow.width : 0)))
        let x = floor((width - min(total, room)) / 2 / pixel) * pixel
        let top = floor((close.midY - titleSize.height / 2) / pixel) * pixel - 1
        self.title = CGRect(x: x, y: top, width: titleWidth, height: titleSize.height)
        arrow = hasArrow ? CGRect(x: x + titleWidth + 1, y: top + titleSize.height / 2 - Self.arrow.height / 2 + 1 - pixel, width: Self.arrow.width, height: Self.arrow.height) : nil
        edge = CGRect(x: 0, y: 0, width: width, height: M.topEdge)
    }
}

/// The page under the header: the gallery's limited-access note and grid
/// running under the header, and the other pages below it, in the
/// content's space.
public struct AttachMenuContentLayout: Equatable, Sendable {
    public struct Input {
        public var width: CGFloat
        public var height: CGFloat
        public var sides: LayoutInsets
        public var wide: Bool
        public var pixel: CGFloat
        public var count: Int
        public var camera: Bool
        /// The limited-access note's text and button title, when it shows.
        public var note: Measurable?
        public var noteButton: CGSize?
        /// The content below the screen (a resting sheet's).
        public var hidden: CGFloat

        public init(width: CGFloat, height: CGFloat, sides: LayoutInsets = .zero, wide: Bool, pixel: CGFloat, count: Int, camera: Bool, note: Measurable? = nil, noteButton: CGSize? = nil, hidden: CGFloat = 0) {
            self.width = width
            self.height = height
            self.sides = sides
            self.wide = wide
            self.pixel = pixel
            self.count = count
            self.camera = camera
            self.note = note
            self.noteButton = noteButton
            self.hidden = hidden
        }
    }

    /// The grid's frame: the whole content, the header over its top.
    public var gridFrame: CGRect
    /// Under the header, to the content's foot: the other pages.
    public var page: CGRect
    /// The grid, in its content's space, under its top inset.
    public var grid: AttachMenuGridLayout
    public var topInset: CGFloat
    public var note: CGRect?
    public var noteText: CGRect?
    public var noteButton: CGRect?
    /// The page's foot kept clear: the content below the screen and the bar.
    public var bottomInset: CGFloat
    /// What of the page shows above the bar.
    public var visibleHeight: CGFloat

    public init(_ input: Input) {
        typealias M = AttachMenuMetrics
        typealias N = LibraryPickerLayout.Metrics
        let width = max(0, input.width)
        let height = max(0, input.height)
        gridFrame = CGRect(x: 0, y: 0, width: width, height: height)
        topInset = M.headerHeight
        page = CGRect(x: 0, y: M.headerHeight, width: width, height: max(0, height - M.headerHeight))
        bottomInset = max(0, input.hidden) + M.barReserve
        visibleHeight = max(0, page.height - bottomInset)

        var top: CGFloat = 0
        if let measured = input.note, let button = input.noteButton {
            let left = input.sides.left
            let inner = max(0, width - left - input.sides.right)
            let buttonWidth = ceil(button.width) + N.noteButtonPadding
            let text = measured.size(fitting: max(0, inner - N.noteTextInset - buttonWidth - N.noteGap))
            let noteHeight = max(N.noteMinHeight, ceil(text.height) + N.notePadding)
            note = CGRect(x: 0, y: 0, width: width, height: noteHeight)
            noteText = CGRect(x: left + N.noteTextInset, y: floor((noteHeight - text.height) / 2) - N.noteLift, width: ceil(text.width), height: ceil(text.height))
            noteButton = CGRect(x: width - input.sides.right - N.noteButtonInset - buttonWidth, y: floor((noteHeight - N.noteButtonHeight) / 2) - N.noteLift, width: buttonWidth, height: N.noteButtonHeight)
            top = noteHeight
        } else {
            note = nil
            noteText = nil
            noteButton = nil
        }
        grid = AttachMenuGridLayout(width: width, left: input.sides.left, right: input.sides.right, wide: input.wide, pixel: input.pixel, count: input.count, camera: input.camera, top: top)
    }
}

/// No library: what it would show, why, and the ways that still work, as
/// Telegram's no-access placeholder lays them out: a picture, a title, the
/// text, the primary button under it, then the plain buttons. Centred in
/// the page's visible height; taller than that, it scrolls from the top.
public struct AttachMenuPlaceholderLayout: Equatable, Sendable {
    public enum Metrics {
        public static let image: CGFloat = 96
        public static let imageGap: CGFloat = 12
        public static let textGap: CGFloat = 12
        public static let buttonGap: CGFloat = 20
        public static let linkGap: CGFloat = 13
        public static let side: CGFloat = 20
        public static let buttonWidth: CGFloat = 248
        public static let buttonHeight: CGFloat = 52
        public static let buttonPadding: CGFloat = 16
        public static let buttonVerticalPadding: CGFloat = 14
        public static let linkHeight: CGFloat = 44
        public static let linkPadding: CGFloat = 8
    }

    public var image: CGRect?
    public var title: CGRect
    public var text: CGRect
    /// The system's picker: Photos, under the explanation.
    public var primary: CGRect
    /// Settings, to let the app see the library after all.
    public var settings: CGRect
    public var camera: CGRect?
    public var contentHeight: CGFloat

    /// `title`, `text` measure at the width they're offered; `primary`,
    /// `settings` and `camera` are the buttons' titles measured.
    public init(width: CGFloat, height: CGFloat, upright: Bool, title: Measurable, text: Measurable, primary: CGSize, settings: CGSize, camera: CGSize?) {
        typealias M = Metrics
        let width = max(0, width)
        let inner = max(0, width - 2 * M.side)
        let titleSize = title.size(fitting: inner)
        let textSize = text.size(fitting: inner)
        let buttonWidth = min(inner, max(M.buttonWidth, ceil(primary.width) + 2 * M.buttonPadding))
        let buttonHeight = max(M.buttonHeight, ceil(primary.height) + 2 * M.buttonVerticalPadding)
        func link(_ size: CGSize) -> CGSize {
            CGSize(width: min(inner, ceil(size.width) + 2 * M.linkPadding), height: max(M.linkHeight, ceil(size.height) + 2 * M.linkPadding))
        }
        let settingsSize = link(settings)
        let cameraSize = camera.map(link)
        let imageHeight = upright ? M.image + M.imageGap : 0
        var total = imageHeight + ceil(titleSize.height) + M.textGap + ceil(textSize.height) + M.buttonGap + buttonHeight + M.linkGap + settingsSize.height
        if let cameraSize { total += cameraSize.height }
        let top = max(0, floor((max(0, height) - total) / 2))
        func centred(_ size: CGSize, _ y: CGFloat) -> CGRect {
            let w = ceil(size.width)
            return CGRect(x: floor((width - w) / 2), y: y, width: w, height: ceil(size.height))
        }
        image = upright ? CGRect(x: floor((width - M.image) / 2), y: top, width: M.image, height: M.image) : nil
        self.title = centred(titleSize, top + imageHeight)
        self.text = centred(textSize, self.title.maxY + M.textGap)
        self.primary = CGRect(x: floor((width - buttonWidth) / 2), y: self.text.maxY + M.buttonGap, width: buttonWidth, height: buttonHeight)
        self.settings = centred(settingsSize, self.primary.maxY + M.linkGap)
        let below = self.settings.maxY
        self.camera = cameraSize.map { centred($0, below) }
        contentHeight = max(max(0, height), top + total)
    }
}

/// The Files tab: Telegram's "Select from Gallery" and "Select from
/// Files", one rounded group of rows under the header.
public struct AttachMenuFilesLayout: Equatable, Sendable {
    public enum Metrics {
        public static let side: CGFloat = 16
        public static let top: CGFloat = 8
        public static let rowHeight: CGFloat = 52
        public static let rowPadding: CGFloat = 14
        public static let radius: CGFloat = 26
        public static let icon: CGFloat = 24
        public static let iconLeading: CGFloat = 16
        public static let iconGap: CGFloat = 14
        public static let trailing: CGFloat = 16
    }

    public struct Row: Equatable, Sendable {
        /// In the group's space.
        public var frame: CGRect
        public var icon: CGRect
        public var title: CGRect
        /// The hairline above it, from the title's start; none on the first.
        public var separator: CGRect?
    }

    /// In the page's space.
    public var group: CGRect
    public var rows: [Row]
    public var contentHeight: CGFloat

    /// `titles` are the rows' titles measured at any width; long ones
    /// wrap, and a row grows with its text (Dynamic Type).
    public init(width: CGFloat, sides: LayoutInsets = .zero, titles: [Measurable], pixel: CGFloat) {
        typealias M = Metrics
        let groupWidth = max(0, width - sides.left - sides.right - 2 * M.side)
        let titleX = M.iconLeading + M.icon + M.iconGap
        let titleWidth = max(0, groupWidth - titleX - M.trailing)
        var y: CGFloat = 0
        rows = titles.enumerated().map { index, title in
            let size = title.size(fitting: titleWidth)
            let height = max(M.rowHeight, ceil(size.height) + 2 * M.rowPadding)
            let frame = CGRect(x: 0, y: y, width: groupWidth, height: height)
            y += height
            return Row(
                frame: frame,
                icon: CGRect(x: M.iconLeading, y: frame.minY + floor((height - M.icon) / 2), width: M.icon, height: M.icon),
                title: CGRect(x: titleX, y: frame.minY + floor((height - ceil(size.height)) / 2), width: titleWidth, height: ceil(size.height)),
                separator: index == 0 ? nil : CGRect(x: titleX, y: frame.minY, width: max(0, groupWidth - titleX), height: max(pixel, 0.0001))
            )
        }
        group = CGRect(x: sides.left + M.side, y: M.top, width: groupWidth, height: y)
        contentHeight = group.maxY + AttachMenuMetrics.barReserve
    }
}
