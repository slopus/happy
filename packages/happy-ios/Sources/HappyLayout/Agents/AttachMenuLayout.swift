import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The composer's "+" menu, measured as Telegram's attachment menu
/// (`AttachmentContainer`, `AttachmentController`, `AttachmentPanel`,
/// `MediaPickerScreen`, `MediaPickerPlaceholderNode`):
///
///     ╭──────── ▬ ────────╮   a sheet over the dimmed chat, a quarter of
///     │      Recents   (×)│   the screen down; dragged up it fills the
///     │ ┌──┐ ▢ ▢           │   screen, dragged down it goes
///     │ │📷│ ▢ ▢           │   the camera two rows tall at the top left,
///     │ └──┘ ▢ ▢ ▢ ...     │   the library newest first around it
///     │    ( Gallery|Files )│   a glass tab bar 22 off the bottom, which
///     ╰───────────────────╯   turns into "Add N" while photos are picked
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
    public static let grabber = CGSize(width: 36, height: 5)
    public static let grabberTop: CGFloat = 5
    /// The camera cell's glyph, centred in the cell.
    public static let cameraIcon: CGFloat = 30

    /// The iPad card, over the "+" (`containerLayoutUpdated`, regular width).
    public static let cardSize = CGSize(width: 390, height: 670)
    public static let cardTrailing: CGFloat = 28
    public static let cardBottom: CGFloat = 54
    public static let cardMargin: CGFloat = 16

    /// The header: the close circle (`SheetCloseLayout`) and the title on its middle.
    public static let headerBottom: CGFloat = 8
    public static let titleGap: CGFloat = 8

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
    /// While photos are picked the bar is one button, 28 in from the sides.
    public static let addHeight: CGFloat = 52
    public static let addSide: CGFloat = 28
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
    /// A drag that goes: 60 past rest (180 from expanded when the sheet
    /// can't rest lower), or any drop flicked down at 300 pt/s; expanded at
    /// the top, a flick of 1800.
    public static let dismissDistance: CGFloat = 60
    public static let flick: CGFloat = 300
    public static let hardFlick: CGFloat = 1800
    /// Switching tabs: the old page fades over 0.23 s while the sheet dips
    /// 10 in 0.2 s and springs back (damping 70) in 0.3.
    public static let switchFade: TimeInterval = 0.23
    public static let switchDip: CGFloat = 10
    public static let switchDipDuration: TimeInterval = 0.2
    public static let switchReturnDuration: TimeInterval = 0.3
    public static let switchReturnDamping: CGFloat = 70
    /// The bar turning into "Add N" and back.
    public static let barDuration: TimeInterval = 0.4

    /// Where a drag leaves the sheet (`AttachmentContainer.panGesture`).
    public enum Settle: Equatable, Sendable {
        case dismiss
        case expand
        case collapse
        /// Back where it was, expanded or not.
        case stay
    }

    /// `offset` is how far below its expanded top the sheet was dragged,
    /// `drop` how far it was pulled below where it can rest, `velocity` the
    /// finger's, down positive. `scrolled` is a grid scrolled off its top,
    /// which takes the flick instead.
    public static func settle(expanded: Bool, canCollapse: Bool, travel: CGFloat, offset: CGFloat, drop: CGFloat, velocity: CGFloat, scrolled: Bool) -> Settle {
        let velocity = expanded && scrolled ? 0 : velocity
        let threshold = canCollapse ? dismissDistance : 3 * dismissDistance
        if drop > threshold || (drop > 0 && velocity > flick) || (expanded && drop == 0 && velocity > hardFlick) {
            return .dismiss
        }
        guard canCollapse else { return .stay }
        if expanded {
            return velocity > flick || offset > travel / 2 ? .collapse : .stay
        }
        return velocity < -flick || offset < travel / 2 ? .expand : .stay
    }

    /// The drag's sheet: how far below its expanded top, and how far below
    /// rest, `translation` (down positive) leaves a sheet that started
    /// expanded or at rest.
    public static func drag(expanded: Bool, canCollapse: Bool, travel: CGFloat, translation: CGFloat) -> (offset: CGFloat, drop: CGFloat) {
        guard canCollapse else { return (0, max(0, translation)) }
        if expanded {
            return (min(travel, max(0, translation)), max(0, translation - travel))
        }
        return (max(0, travel + min(0, translation)), max(0, translation))
    }
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

    /// The grabber at the top of a sheet, in the clip's space.
    public func grabber(clipWidth: CGFloat) -> CGRect? {
        guard style == .sheet else { return nil }
        let size = AttachMenuMetrics.grabber
        return CGRect(x: floor((clipWidth - size.width) / 2), y: AttachMenuMetrics.grabberTop, width: size.width, height: size.height)
    }
}

/// The glass tab bar, or "Add N" while photos are picked, in the window's space.
public struct AttachMenuBarLayout: Equatable, Sendable {
    public struct Tab: Equatable, Sendable {
        /// In the capsule's space.
        public var frame: CGRect
        public var icon: CGRect
        public var title: CGRect
    }

    public var capsule: CGRect
    public var cornerRadius: CGFloat
    public var tabs: [Tab]
    /// The selected tab's pill, in the capsule's space.
    public var selection: CGRect
    /// "Add N", centred in the capsule.
    public var add: CGRect

    /// `width` and `minX` are the sheet's, `bottom` its bottom edge;
    /// `titles` the tabs' names measured, `addTitle` the button's.
    public init(minX: CGFloat, width: CGFloat, bottom: CGFloat, titles: [CGSize], selected: Int, picking: Bool, addTitle: CGSize, pixel: CGFloat) {
        typealias M = AttachMenuMetrics
        let barWidth = min(M.barWidth(tabs: titles.count), max(0, width - 2 * M.barBottom))
        let tabsCapsule = CGRect(x: minX + floor((width - barWidth) / 2), y: bottom - M.barBottom - M.barHeight, width: barWidth, height: M.barHeight)
        let pitch = titles.count > 1 ? floor((barWidth - 2 * M.barInset - M.tabWidth) / CGFloat(titles.count - 1)) : 0
        let iconTop = 9 + pixel
        tabs = titles.enumerated().map { index, title in
            let frame = CGRect(x: M.barInset + CGFloat(index) * pitch, y: 0, width: M.tabWidth, height: M.barHeight)
            let icon = CGRect(x: frame.minX + (M.tabWidth - M.tabIcon) / 2, y: iconTop, width: M.tabIcon, height: M.tabIcon)
            let titleWidth = min(ceil(title.width), M.tabWidth)
            let titleHeight = ceil(title.height)
            let centerY = icon.midY + 15 + 2 * pixel
            return Tab(frame: frame, icon: icon, title: CGRect(x: frame.minX + floor((M.tabWidth - titleWidth) / 2), y: centerY - titleHeight / 2, width: titleWidth, height: titleHeight))
        }
        let chosen = tabs.indices.contains(selected) ? tabs[selected].frame : .zero
        selection = CGRect(x: chosen.minX, y: M.barInset, width: chosen.width, height: M.barHeight - 2 * M.barInset)
        if picking {
            let addWidth = max(0, width - 2 * M.addSide)
            capsule = CGRect(x: minX + M.addSide, y: bottom - M.barBottom - M.addHeight, width: addWidth, height: M.addHeight)
        } else {
            capsule = tabsCapsule
        }
        cornerRadius = capsule.height / 2
        let addWidth = min(ceil(addTitle.width), capsule.width)
        let addHeight = ceil(addTitle.height)
        add = CGRect(x: floor((capsule.width - addWidth) / 2), y: floor((capsule.height - addHeight) / 2), width: addWidth, height: addHeight)
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
        let cells = self.count + (camera ? 2 : 0)
        let rows = max(camera ? 2 : 0, (cells + columns - 1) / columns)
        contentHeight = top + CGFloat(rows) * side + CGFloat(max(0, rows - 1)) * M.spacing
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

/// The page under the header: the gallery's header, its limited-access
/// note and grid, in the content's space.
public struct AttachMenuContentLayout: Equatable, Sendable {
    public struct Input {
        public var width: CGFloat
        public var height: CGFloat
        public var sides: LayoutInsets
        public var title: CGSize
        public var wide: Bool
        public var pixel: CGFloat
        public var count: Int
        public var camera: Bool
        /// The limited-access note's text and button title, when it shows.
        public var note: Measurable?
        public var noteButton: CGSize?
        /// The content below the screen (a resting sheet's).
        public var hidden: CGFloat

        public init(width: CGFloat, height: CGFloat, sides: LayoutInsets = .zero, title: CGSize, wide: Bool, pixel: CGFloat, count: Int, camera: Bool, note: Measurable? = nil, noteButton: CGSize? = nil, hidden: CGFloat = 0) {
            self.width = width
            self.height = height
            self.sides = sides
            self.title = title
            self.wide = wide
            self.pixel = pixel
            self.count = count
            self.camera = camera
            self.note = note
            self.noteButton = noteButton
            self.hidden = hidden
        }
    }

    public var close: CGRect
    public var title: CGRect
    /// Under the header, to the content's foot.
    public var page: CGRect
    /// The grid in the page's space.
    public var grid: AttachMenuGridLayout
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
        close = SheetCloseLayout.frame(width: width - input.sides.right)
        let titleWidth = min(ceil(max(0, input.title.width)), max(0, width - 2 * (width - close.minX + M.titleGap)))
        let titleHeight = ceil(max(0, input.title.height))
        title = CGRect(x: floor((width - titleWidth) / 2), y: floor(close.midY - titleHeight / 2), width: titleWidth, height: titleHeight)
        let pageTop = close.maxY + M.headerBottom
        page = CGRect(x: 0, y: pageTop, width: width, height: max(0, input.height - pageTop))
        bottomInset = max(0, input.hidden) + M.barReserve
        visibleHeight = max(0, page.height - bottomInset)

        var top: CGFloat = 0
        if let measured = input.note, let button = input.noteButton {
            let left = input.sides.left
            let inner = max(0, width - left - input.sides.right)
            let buttonWidth = ceil(button.width) + N.noteButtonPadding
            let text = measured.size(fitting: max(0, inner - N.noteTextInset - buttonWidth - N.noteGap))
            let height = max(N.noteMinHeight, ceil(text.height) + N.notePadding)
            note = CGRect(x: 0, y: 0, width: width, height: height)
            noteText = CGRect(x: left + N.noteTextInset, y: floor((height - text.height) / 2) - N.noteLift, width: ceil(text.width), height: ceil(text.height))
            noteButton = CGRect(x: width - input.sides.right - N.noteButtonInset - buttonWidth, y: floor((height - N.noteButtonHeight) / 2) - N.noteLift, width: buttonWidth, height: N.noteButtonHeight)
            top = height
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
