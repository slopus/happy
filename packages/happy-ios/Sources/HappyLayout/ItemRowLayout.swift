import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A settings row: optional icon, a title with an optional subtitle, and on
/// the right an optional detail, a trailing element (a switch, checkmark,
/// spinner or dropdown value: Item.tsx's `rightElement` and `loading`) and
/// a chevron. Ported from packages/happy-app/sources/components/Item.tsx
/// (iOS values).
///
///     |16| icon 29 |12| title / 2 / subtitle  |8| detail |6| trailing |6|4| › |16|
///     ───────────────── divider, inset 15 + (icon ? 60 : 16) ───────────────────
public struct ItemRowLayout: Equatable, Sendable {
    public enum Metrics {
        public static let minHeight: CGFloat = 44
        public static let paddingHorizontal: CGFloat = 16
        public static let paddingVertical: CGFloat = 12
        public static let paddingVerticalWithSubtitle: CGFloat = 11
        public static let iconSize: CGFloat = 29
        public static let iconSpacing: CGFloat = 12
        public static let subtitleSpacing: CGFloat = 2
        public static let rightSectionSpacing: CGFloat = 8
        public static let detailAccessorySpacing: CGFloat = 6
        public static let accessoryLeading: CGFloat = 4
        public static let dividerHeight: CGFloat = 0.33
        public static let dividerInset: CGFloat = 15
        /// RN lets a long detail squeeze the title to nothing. Here the detail
        /// gets at most this share of the row, so the title always shows.
        public static let detailMaxShare: CGFloat = 0.6
    }

    public struct Input {
        public var width: CGFloat
        public var hasIcon: Bool
        public var title: Measurable
        public var subtitle: Measurable?
        public var detail: Measurable?
        /// A switch, checkmark, spinner or dropdown value, sized by itself.
        public var trailing: CGSize?
        /// The chevron's glyph size; nil when the row shows no chevron.
        public var accessory: CGSize?
        public var showsDivider: Bool

        public init(
            width: CGFloat,
            hasIcon: Bool = false,
            title: Measurable,
            subtitle: Measurable? = nil,
            detail: Measurable? = nil,
            trailing: CGSize? = nil,
            accessory: CGSize? = nil,
            showsDivider: Bool = false
        ) {
            self.width = width
            self.hasIcon = hasIcon
            self.title = title
            self.subtitle = subtitle
            self.detail = detail
            self.trailing = trailing
            self.accessory = accessory
            self.showsDivider = showsDivider
        }
    }

    /// The whole row, divider included.
    public var size: CGSize
    /// The tappable part, without the divider under it.
    public var rowHeight: CGFloat
    public var icon: CGRect?
    public var title: CGRect
    public var subtitle: CGRect?
    public var detail: CGRect?
    public var trailing: CGRect?
    public var accessory: CGRect?
    public var divider: CGRect?

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.width)
        let padV = input.subtitle == nil ? M.paddingVertical : M.paddingVerticalWithSubtitle
        let centerX = M.paddingHorizontal + (input.hasIcon ? M.iconSize + M.iconSpacing : 0)
        // Everything between the leading edge of the text and the trailing
        // padding, including the right section's leading margin.
        let available = max(0, width - centerX - M.paddingHorizontal - M.rightSectionSpacing)

        let accessoryWidth = input.accessory.map { M.accessoryLeading + $0.width } ?? 0
        let trailingGap = input.trailing != nil && input.accessory != nil ? M.detailAccessorySpacing : 0
        let trailingWidth = input.trailing.map { $0.width + trailingGap } ?? 0
        let detailGap = input.detail != nil && (input.accessory != nil || input.trailing != nil) ? M.detailAccessorySpacing : 0
        let detailSize = input.detail.map {
            $0.size(fitting: max(0, available - accessoryWidth - trailingWidth - detailGap) * M.detailMaxShare)
        }
        let rightWidth = (detailSize?.width ?? 0) + detailGap + trailingWidth + accessoryWidth
        let centerWidth = max(0, available - rightWidth)

        let titleHeight = input.title.height(fitting: centerWidth)
        let subtitleHeight = input.subtitle?.height(fitting: centerWidth)
        let centerHeight = titleHeight + (subtitleHeight.map { M.subtitleSpacing + $0 } ?? 0)

        let contentHeight = max(
            centerHeight,
            input.hasIcon ? M.iconSize : 0,
            detailSize?.height ?? 0,
            input.trailing?.height ?? 0,
            input.accessory?.height ?? 0
        )
        let rowHeight = max(M.minHeight, contentHeight + padV * 2)
        let midY = rowHeight / 2

        self.rowHeight = rowHeight
        self.icon = input.hasIcon
            ? CGRect(x: M.paddingHorizontal, y: midY - M.iconSize / 2, width: M.iconSize, height: M.iconSize)
            : nil

        let titleFrame = CGRect(x: centerX, y: midY - centerHeight / 2, width: centerWidth, height: titleHeight)
        self.title = titleFrame
        self.subtitle = subtitleHeight.map {
            CGRect(x: centerX, y: titleFrame.maxY + M.subtitleSpacing, width: centerWidth, height: $0)
        }

        let rightX = width - M.paddingHorizontal - rightWidth
        self.detail = detailSize.map {
            CGRect(x: rightX, y: midY - $0.height / 2, width: $0.width, height: $0.height)
        }
        self.trailing = input.trailing.map {
            CGRect(x: width - M.paddingHorizontal - accessoryWidth - trailingGap - $0.width, y: midY - $0.height / 2, width: $0.width, height: $0.height)
        }
        self.accessory = input.accessory.map {
            CGRect(x: width - M.paddingHorizontal - $0.width, y: midY - $0.height / 2, width: $0.width, height: $0.height)
        }

        if input.showsDivider {
            let inset = M.dividerInset + (input.hasIcon ? M.paddingHorizontal + M.iconSize + 15 : M.paddingHorizontal)
            self.divider = CGRect(x: inset, y: rowHeight, width: max(0, width - inset), height: M.dividerHeight)
        } else {
            self.divider = nil
        }
        self.size = CGSize(width: width, height: rowHeight + (input.showsDivider ? M.dividerHeight : 0))
    }
}
