import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Stem Cells settings, after Telegram's settings (techniques only): under
/// the glass bar (`StemCellsGlassBarLayout`), scrolling, the profiles as a
/// strip of circles, the chosen one's name and line, and grouped cards.
///
/// The profiles as story circles: the chosen one centred, larger and
/// ringed, the others smaller either side; each grows as it nears the
/// middle, so a drag scales them continuously and a stop snaps to one.
public enum StemCellsProfileCarousel {
    public enum Metrics {
        public static let selected: CGFloat = 92
        public static let other: CGFloat = 60
        /// Centre to centre.
        public static let pitch: CGFloat = 84
        public static let ringWidth: CGFloat = 3
        /// Between the picture and its ring.
        public static let ringGap: CGFloat = 3
        /// The strip: the chosen circle with its ring.
        public static let height: CGFloat = selected + 2 * (ringWidth + ringGap)
    }

    public struct Item: Equatable, Sendable {
        /// The picture, in the strip's content space.
        public var frame: CGRect
        /// 1 in the middle, 0 a pitch or more away: the ring's alpha.
        public var emphasis: CGFloat
    }

    public static func contentWidth(count: Int, width: CGFloat) -> CGFloat {
        width + CGFloat(max(0, count - 1)) * Metrics.pitch
    }

    /// The offset that centres item `index`.
    public static func offset(for index: Int) -> CGFloat {
        CGFloat(index) * Metrics.pitch
    }

    /// The item nearest the middle at `offset`.
    public static func index(at offset: CGFloat, count: Int) -> Int {
        guard count > 0 else { return 0 }
        return min(count - 1, max(0, Int((offset / Metrics.pitch).rounded())))
    }

    /// Where a flick that would stop at `target` comes to rest: on an item.
    public static func snapped(_ target: CGFloat, count: Int) -> CGFloat {
        offset(for: index(at: target, count: count))
    }

    public static func item(_ index: Int, offset: CGFloat, width: CGFloat) -> Item {
        typealias M = Metrics
        let center = width / 2 + CGFloat(index) * M.pitch
        let distance = abs(center - (offset + width / 2))
        let emphasis = 1 - min(1, distance / M.pitch)
        let side = M.other + (M.selected - M.other) * emphasis
        return Item(
            frame: CGRect(x: center - side / 2, y: (M.height - side) / 2, width: side, height: side),
            emphasis: emphasis
        )
    }
}

/// The scrolling part: the strip, the chosen profile's name and line under
/// it, then the cards.
public struct StemCellsSettingsLayout: Equatable, Sendable {
    public enum Metrics {
        public static let stripTop: CGFloat = 8
        public static let nameGap: CGFloat = 12
        public static let subtitleGap: CGFloat = 2
        public static let textSide: CGFloat = 24
        public static let cardsTop: CGFloat = 28
        /// Telegram's inset cards on a phone, in its glass style.
        public static let side: CGFloat = 16
        public static let radius: CGFloat = 26
        public static let cardGap: CGFloat = 24
        public static let row: CGFloat = 52
        /// The coloured square a row's glyph sits on, and the glyph.
        public static let tile: CGFloat = 30
        public static let tileRadius: CGFloat = 8
        public static let glyph: CGFloat = 20
        /// The title's start with a tile (Telegram's 16 + 46), and without.
        public static let textX: CGFloat = 62
        public static let plainTextX: CGFloat = 16
        public static let titleHeight: CGFloat = 22
        public static let chevron = CGSize(width: 8, height: 14)
        public static let trailing: CGFloat = 16
        public static let valueGap: CGFloat = 8
        public static let toggle = CGSize(width: 63, height: 28)
        public static let separator: CGFloat = 1 / 3
        public static let bottom: CGFloat = 32
        /// Searching with nothing found: the line, under the bar.
        public static let emptyTop: CGFloat = 32
        public static let emptyHeight: CGFloat = 24
    }

    public enum Accessory: Equatable, Sendable {
        case chevron
        case toggle
        case none
    }

    public struct RowSpec: Equatable, Sendable {
        public var hasIcon: Bool
        /// The value's width before the chevron or at the end, if any.
        public var valueWidth: CGFloat?
        public var accessory: Accessory
        public init(hasIcon: Bool, valueWidth: CGFloat? = nil, accessory: Accessory) {
            self.hasIcon = hasIcon
            self.valueWidth = valueWidth
            self.accessory = accessory
        }
    }

    /// One row, in its card's space.
    public struct Row: Equatable, Sendable {
        public var box: CGRect
        public var icon: CGRect?
        public var title: CGRect
        public var value: CGRect?
        public var chevron: CGRect?
        public var toggle: CGRect?
        /// Under the row, from the title's start; nil under a card's last row.
        public var separator: CGRect?
    }

    public struct Card: Equatable, Sendable {
        public var frame: CGRect
        public var rows: [Row]
    }

    public var strip: CGRect
    public var name: CGRect
    public var subtitle: CGRect
    public var cards: [Card]
    /// "Nothing found", while searching.
    public var empty: CGRect
    public var contentHeight: CGFloat

    /// Searching, the strip and the name are hidden and the cards move up
    /// into the strip's place.
    public init(width: CGFloat, nameHeight: CGFloat, subtitleHeight: CGFloat, cards specs: [[RowSpec]], searching: Bool = false) {
        typealias M = Metrics
        strip = CGRect(x: 0, y: M.stripTop, width: width, height: StemCellsProfileCarousel.Metrics.height)
        let textWidth = max(0, width - 2 * M.textSide)
        name = CGRect(x: M.textSide, y: strip.maxY + M.nameGap, width: textWidth, height: nameHeight)
        subtitle = CGRect(x: M.textSide, y: name.maxY + M.subtitleGap, width: textWidth, height: subtitleHeight)
        let cardWidth = max(0, width - 2 * M.side)
        var y = searching ? M.stripTop : subtitle.maxY + M.cardsTop
        empty = CGRect(x: 0, y: M.stripTop + M.emptyTop, width: width, height: M.emptyHeight)
        var cards: [Card] = []
        for spec in specs where !spec.isEmpty {
            var rows: [Row] = []
            for (index, row) in spec.enumerated() {
                rows.append(Self.row(row, y: CGFloat(index) * M.row, width: cardWidth, last: index == spec.count - 1))
            }
            cards.append(Card(frame: CGRect(x: M.side, y: y, width: cardWidth, height: CGFloat(spec.count) * M.row), rows: rows))
            y += CGFloat(spec.count) * M.row + M.cardGap
        }
        self.cards = cards
        contentHeight = (cards.last.map { $0.frame.maxY } ?? (searching ? M.stripTop : subtitle.maxY)) + M.bottom
    }

    static func row(_ spec: RowSpec, y: CGFloat, width: CGFloat, last: Bool) -> Row {
        typealias M = Metrics
        let textX = spec.hasIcon ? M.textX : M.plainTextX
        var right = width - M.trailing
        var chevron: CGRect?
        var toggle: CGRect?
        switch spec.accessory {
        case .chevron:
            chevron = CGRect(x: right - M.chevron.width, y: y + (M.row - M.chevron.height) / 2, width: M.chevron.width, height: M.chevron.height)
            right -= M.chevron.width + M.valueGap
        case .toggle:
            toggle = CGRect(x: right - M.toggle.width, y: y + (M.row - M.toggle.height) / 2, width: M.toggle.width, height: M.toggle.height)
            right -= M.toggle.width + M.valueGap
        case .none:
            break
        }
        var value: CGRect?
        if let valueWidth = spec.valueWidth {
            let fitted = min(valueWidth.rounded(.up), max(0, (right - textX) / 2))
            value = CGRect(x: right - fitted, y: y + (M.row - M.titleHeight) / 2, width: fitted, height: M.titleHeight)
            right -= fitted + M.valueGap
        }
        return Row(
            box: CGRect(x: 0, y: y, width: width, height: M.row),
            icon: spec.hasIcon ? CGRect(x: (M.textX - M.tile) / 2, y: y + (M.row - M.tile) / 2, width: M.tile, height: M.tile) : nil,
            title: CGRect(x: textX, y: y + (M.row - M.titleHeight) / 2, width: max(0, right - textX), height: M.titleHeight),
            value: value,
            chevron: chevron,
            toggle: toggle,
            separator: last ? nil : CGRect(x: textX, y: y + M.row - M.separator, width: width - textX, height: M.separator)
        )
    }
}

/// The QR sheet over the chosen profile, after Telegram's QR screen: the
/// picture and the name in capitals above a sheet with a close button, a
/// title, a line, and the two buttons. Nothing of a profile is safe to
/// show as a code (a direct computer's would carry its address, an
/// account's its key), so no code card is drawn and Scan is the first
/// button.
public struct StemCellsQRSheetLayout: Equatable, Sendable {
    public enum Metrics {
        public static let avatar: CGFloat = 100
        public static let nameGap: CGFloat = 16
        /// Telegram's sheet: 38 round, its title in a 54 band.
        public static let radius: CGFloat = 38
        public static let close: CGFloat = SheetCloseLayout.size
        public static let titleBand: CGFloat = 54
        public static let titleCenter: CGFloat = 36
        public static let titleHeight: CGFloat = 22
        public static let textSide: CGFloat = 30
        public static let textGap: CGFloat = 4
        public static let buttonsGap: CGFloat = 24
        public static let button: CGFloat = 52
        public static let buttonGap: CGFloat = 10
        public static let bottom: CGFloat = 16
    }

    public var avatar: CGRect
    public var name: CGRect
    public var sheet: CGRect
    /// The rest in the sheet's own space.
    public var close: CGRect
    public var title: CGRect
    public var text: CGRect
    public var primary: CGRect
    public var secondary: CGRect

    public init(size: CGSize, safeTop: CGFloat, safeBottom: CGFloat, nameHeight: CGFloat, text: Measurable) {
        typealias M = Metrics
        let inner = max(0, size.width - 2 * M.textSide)
        close = SheetCloseLayout.frame(width: size.width)
        title = CGRect(x: M.textSide + M.close, y: M.titleCenter - M.titleHeight / 2, width: max(0, size.width - 2 * (M.textSide + M.close)), height: M.titleHeight)
        self.text = CGRect(x: M.textSide, y: M.titleBand + M.textGap, width: inner, height: text.height(fitting: inner))
        primary = CGRect(x: M.textSide, y: self.text.maxY + M.buttonsGap, width: inner, height: M.button)
        secondary = CGRect(x: M.textSide, y: primary.maxY + M.buttonGap, width: inner, height: M.button)
        let height = secondary.maxY + max(safeBottom, M.bottom)
        sheet = CGRect(x: 0, y: size.height - height, width: size.width, height: height)
        let block = M.avatar + M.nameGap + nameHeight
        let top = safeTop + max(0, ((sheet.minY - safeTop - block) / 2).rounded())
        avatar = CGRect(x: ((size.width - M.avatar) / 2).rounded(), y: top, width: M.avatar, height: M.avatar)
        name = CGRect(x: M.textSide, y: avatar.maxY + M.nameGap, width: inner, height: nameHeight)
    }
}

/// The link sheet's content, over its buttons: the title, centred, then
/// what to do on the computer.
public struct StemCellsLinkContentLayout: Equatable, Sendable {
    public enum Metrics {
        /// From the title to the first step, as the relay's checklist has it.
        public static let stepsGap: CGFloat = LinkComputerContentLayout.Metrics.checklistMarginTop
        public static let bottom: CGFloat = 12
    }

    public var title: CGRect
    /// Each step as a checklist row, its number where the box goes.
    public var steps: [ChecklistRowLayout]
    public var size: CGSize

    public init(width: CGFloat, title: Measurable, steps: [LinkComputerContentLayout.Row]) {
        typealias M = Metrics
        let width = max(0, width)
        self.title = CGRect(x: 0, y: 0, width: width, height: title.height(fitting: width))
        var y = self.title.maxY + M.stepsGap
        var rows: [ChecklistRowLayout] = []
        for (index, step) in steps.enumerated() {
            let row = ChecklistRowLayout(origin: CGPoint(x: 0, y: y), width: width, title: step.title, body: step.body)
            rows.append(row)
            y = row.maxY + (index < steps.count - 1 ? ChecklistRowLayout.Metrics.marginBottom : 0)
        }
        self.steps = rows
        size = CGSize(width: width, height: y + M.bottom)
    }
}

/// The link sheet's Relay | Direct switch: 60% as wide as the screen's
/// buttons and centred over them, just above the primary one
/// (`OnboardingLayout.accessory`), with the Beta tag astride its top edge
/// at Direct's end.
public struct StemCellsLinkSwitchLayout: Equatable, Sendable {
    public enum Metrics {
        public static let height: CGFloat = 36
        /// Of the buttons' width.
        public static let widthShare: CGFloat = 0.6
        /// From the control's right end to the tag's.
        public static let tagInset: CGFloat = 10
    }

    public var control: CGRect
    public var tag: CGRect

    /// In the room the screen keeps for it, `accessory`.
    public init(accessory: CGRect, tag size: CGSize) {
        let width = (accessory.width * Metrics.widthShare).rounded()
        self.init(control: CGRect(x: accessory.minX + ((accessory.width - width) / 2).rounded(), y: accessory.minY, width: width, height: accessory.height), tag: size)
    }

    /// The tag on `control` where it stands now.
    public init(control: CGRect, tag size: CGSize) {
        typealias M = Metrics
        self.control = control
        let tagSize = CGSize(width: size.width.rounded(.up), height: size.height.rounded(.up))
        tag = CGRect(x: control.maxX - M.tagInset - tagSize.width, y: (control.minY - tagSize.height / 2).rounded(), width: tagSize.width, height: tagSize.height)
    }
}

