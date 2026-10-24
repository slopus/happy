import CoreGraphics

/// One of the composer's pickers (Model, Provider, Effort) in its sheet:
/// the title, a notice when the selection isn't an ordinary choice, then
/// each section's heading over its rows in a rounded group, and an optional
/// footer row in a group of its own. A row is its title, an optional
/// subtitle under it, and what it shows at its end (a check, a usage gauge),
/// centred on the row.
public struct StemCellPickerLayout: Equatable, Sendable {
    public enum Metrics {
        public static let titleTop: CGFloat = 22
        public static let titleBottom: CGFloat = 14
        public static let side: CGFloat = 16
        public static let noticePadding: CGFloat = 12
        public static let noticeRadius: CGFloat = 10
        public static let noticeBottom: CGFloat = 14
        public static let headerInset: CGFloat = 16
        public static let headerTop: CGFloat = 18
        public static let headerBottom: CGFloat = 6
        public static let groupRadius: CGFloat = 12
        public static let rowPaddingH: CGFloat = 16
        public static let rowPaddingV: CGFloat = 12
        public static let rowMinHeight: CGFloat = 48
        public static let subtitleGap: CGFloat = 2
        public static let trailingGap: CGFloat = 12
        public static let footerTop: CGFloat = 18
        public static let bottom: CGFloat = 16
    }

    public struct Row {
        public var title: Measurable
        public var subtitle: Measurable?
        /// What the row shows at its end; zero for nothing.
        public var trailing: CGSize

        public init(title: Measurable, subtitle: Measurable? = nil, trailing: CGSize = .zero) {
            self.title = title
            self.subtitle = subtitle
            self.trailing = trailing
        }
    }

    public struct Section {
        public var header: Measurable?
        public var rows: [Row]

        public init(header: Measurable? = nil, rows: [Row]) {
            self.header = header
            self.rows = rows
        }
    }

    public struct PlacedRow: Equatable, Sendable {
        /// The whole row, the touch target.
        public var frame: CGRect
        public var title: CGRect
        public var subtitle: CGRect?
        public var trailing: CGRect?
        /// The hairline under it, inset as a grouped list's; nil for the last.
        public var separator: CGRect?
    }

    public struct PlacedSection: Equatable, Sendable {
        public var header: CGRect?
        public var group: CGRect
        public var rows: [PlacedRow]
    }

    public var title: CGRect
    public var notice: CGRect?
    public var noticeText: CGRect?
    public var sections: [PlacedSection]
    public var footer: PlacedSection?
    /// What the sheet scrolls through.
    public var contentHeight: CGFloat

    public init(width: CGFloat, safeBottom: CGFloat, hairline: CGFloat, title: Measurable, notice: Measurable? = nil, sections: [Section], footer: Row? = nil) {
        typealias M = Metrics
        let inner = max(0, width - 2 * M.side)
        var y = M.titleTop
        let titleSize = title.size(fitting: inner)
        self.title = CGRect(x: M.side, y: y, width: titleSize.width, height: titleSize.height)
        y = self.title.maxY + M.titleBottom

        if let notice {
            let text = notice.size(fitting: max(0, inner - 2 * M.noticePadding))
            let box = CGRect(x: M.side, y: y, width: inner, height: text.height + 2 * M.noticePadding)
            self.notice = box
            noticeText = CGRect(x: box.minX + M.noticePadding, y: box.minY + M.noticePadding, width: text.width, height: text.height)
            y = box.maxY + M.noticeBottom
        } else {
            self.notice = nil
            noticeText = nil
        }

        func group(_ section: Section, top: CGFloat) -> PlacedSection {
            var y = top
            var header: CGRect?
            if let measurable = section.header {
                let size = measurable.size(fitting: max(0, inner - 2 * M.headerInset))
                header = CGRect(x: M.side + M.headerInset, y: y, width: size.width, height: size.height)
                y += size.height + M.headerBottom
            }
            let groupTop = y
            var rows: [PlacedRow] = []
            for (index, row) in section.rows.enumerated() {
                let hasTrailing = row.trailing.width > 0
                let textWidth = max(0, inner - 2 * M.rowPaddingH - (hasTrailing ? row.trailing.width + M.trailingGap : 0))
                let titleSize = row.title.size(fitting: textWidth)
                let subtitleSize = row.subtitle?.size(fitting: textWidth)
                let textHeight = titleSize.height + (subtitleSize.map { M.subtitleGap + $0.height } ?? 0)
                let height = max(M.rowMinHeight, textHeight + 2 * M.rowPaddingV, row.trailing.height + 2 * M.rowPaddingV)
                let frame = CGRect(x: M.side, y: y, width: inner, height: height)
                let textTop = y + ((height - textHeight) / 2).rounded()
                let left = frame.minX + M.rowPaddingH
                let titleFrame = CGRect(x: left, y: textTop, width: titleSize.width, height: titleSize.height)
                rows.append(PlacedRow(
                    frame: frame,
                    title: titleFrame,
                    subtitle: subtitleSize.map { CGRect(x: left, y: titleFrame.maxY + M.subtitleGap, width: $0.width, height: $0.height) },
                    trailing: hasTrailing ? CGRect(
                        x: frame.maxX - M.rowPaddingH - row.trailing.width,
                        y: y + ((height - row.trailing.height) / 2).rounded(),
                        width: row.trailing.width, height: row.trailing.height
                    ) : nil,
                    separator: index < section.rows.count - 1 ? CGRect(x: left, y: frame.maxY - hairline, width: frame.maxX - left, height: hairline) : nil
                ))
                y = frame.maxY
            }
            return PlacedSection(header: header, group: CGRect(x: M.side, y: groupTop, width: inner, height: y - groupTop), rows: rows)
        }

        var placed: [PlacedSection] = []
        for (index, section) in sections.enumerated() {
            if index > 0 { y += M.headerTop }
            let section = group(section, top: y)
            placed.append(section)
            y = section.group.maxY
        }
        self.sections = placed
        if let footer {
            let section = group(Section(rows: [footer]), top: y + M.footerTop)
            self.footer = section
            y = section.group.maxY
        } else {
            self.footer = nil
        }
        contentHeight = y + M.bottom + safeBottom
    }
}

/// A usage gauge at a row's end, as desktop's: what is left, then a ring
/// that drains as the window is spent.
public struct StemCellUsageGaugeLayout: Equatable, Sendable {
    public static let ring: CGFloat = 14
    public static let gap: CGFloat = 4

    public var size: CGSize
    public var text: CGRect
    public var ring: CGRect

    public init(text: CGSize) {
        let height = max(text.height, Self.ring)
        self.text = CGRect(x: 0, y: ((height - text.height) / 2).rounded(), width: text.width, height: text.height)
        ring = CGRect(x: text.width + Self.gap, y: ((height - Self.ring) / 2).rounded(), width: Self.ring, height: Self.ring)
        size = CGSize(width: ring.maxX, height: height)
    }
}

/// The three pickers above the home dock's field: small pills side by side
/// from the field's left edge, `gap` apart and `gap` above it. A pill too
/// wide for what is left is cut to it.
public struct StemCellModelBarLayout: Equatable, Sendable {
    public static let height: CGFloat = 30
    public static let paddingH: CGFloat = 12
    public static let gap: CGFloat = 8

    public var pills: [CGRect]
    public var labels: [CGRect]
    /// The bar's whole box, for what the list keeps clear.
    public var frame: CGRect

    /// `field` is the dock's capsule; `labels` each pill's one-line label.
    public init(field: CGRect, labels: [CGSize]) {
        var x = field.minX
        let y = field.minY - Self.gap - Self.height
        var pills: [CGRect] = []
        var placed: [CGRect] = []
        for label in labels {
            let room = max(0, field.maxX - x)
            let width = min(room, label.width + 2 * Self.paddingH)
            let pill = CGRect(x: x, y: y, width: width, height: Self.height)
            pills.append(pill)
            placed.append(CGRect(x: pill.minX + Self.paddingH, y: y + ((Self.height - label.height) / 2).rounded(), width: max(0, width - 2 * Self.paddingH), height: label.height))
            x = pill.maxX + Self.gap
        }
        self.pills = pills
        self.labels = placed
        frame = CGRect(x: field.minX, y: y, width: field.width, height: Self.height)
    }
}

/// What a picker row shows at its end: its usage gauge, then its check when
/// it is the current choice, `gap` apart and centred on each other.
public struct StemCellPickerTrailingLayout: Equatable, Sendable {
    public static let check: CGFloat = 18
    public static let gap: CGFloat = 10

    public var size: CGSize
    public var gauge: CGRect?
    public var check: CGRect?

    public init(gauge: CGSize?, checked: Bool) {
        let height = max(gauge?.height ?? 0, checked ? Self.check : 0)
        var x: CGFloat = 0
        if let gauge {
            self.gauge = CGRect(x: 0, y: ((height - gauge.height) / 2).rounded(), width: gauge.width, height: gauge.height)
            x = gauge.width + (checked ? Self.gap : 0)
        } else {
            self.gauge = nil
        }
        check = checked ? CGRect(x: x, y: ((height - Self.check) / 2).rounded(), width: Self.check, height: Self.check) : nil
        size = CGSize(width: check?.maxX ?? self.gauge?.maxX ?? 0, height: height)
    }
}
