import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// An inset grouped section: an uppercase header, a rounded card holding the
/// rows, and a footer. Ported from components/ItemGroup.tsx (iOS values).
public struct ItemGroupLayout: Equatable, Sendable {
    public enum Metrics {
        public static let headerPaddingTop: CGFloat = 35
        public static let headerPaddingBottom: CGFloat = 6
        public static let headerPaddingHorizontal: CGFloat = 32
        /// Space above the card when there is no header.
        public static let untitledPaddingTop: CGFloat = 20
        public static let cardMarginHorizontal: CGFloat = 16
        public static let cardCornerRadius: CGFloat = Radius.group
        public static let footerPaddingTop: CGFloat = 6
        public static let footerPaddingBottom: CGFloat = 8
        public static let footerPaddingHorizontal: CGFloat = 32
    }

    public struct Input {
        public var width: CGFloat
        public var title: Measurable?
        public var footer: Measurable?
        /// Each row's height at the card's width.
        public var rows: [Measurable]
        /// The group is centred at this width on wide screens.
        public var maxWidth: CGFloat?
        /// Overrides the space above an untitled card (`headerStyle`).
        public var untitledPaddingTop: CGFloat?
        /// Space below the group (`style.paddingBottom`).
        public var paddingBottom: CGFloat

        public init(
            width: CGFloat,
            title: Measurable? = nil,
            footer: Measurable? = nil,
            rows: [Measurable],
            maxWidth: CGFloat? = nil,
            untitledPaddingTop: CGFloat? = nil,
            paddingBottom: CGFloat = 0
        ) {
            self.width = width
            self.title = title
            self.footer = footer
            self.rows = rows
            self.maxWidth = maxWidth
            self.untitledPaddingTop = untitledPaddingTop
            self.paddingBottom = paddingBottom
        }
    }

    public var size: CGSize
    public var header: CGRect?
    public var card: CGRect
    /// Row frames in the card's coordinates.
    public var rows: [CGRect]
    public var footer: CGRect?

    /// The width rows are laid out at, for measuring them before layout.
    public static func cardWidth(forWidth width: CGFloat, maxWidth: CGFloat? = nil) -> CGFloat {
        max(0, groupWidth(width, maxWidth) - Metrics.cardMarginHorizontal * 2)
    }

    private static func groupWidth(_ width: CGFloat, _ maxWidth: CGFloat?) -> CGFloat {
        let width = max(0, width)
        return maxWidth.map { min(width, $0) } ?? width
    }

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.width)
        let groupWidth = Self.groupWidth(width, input.maxWidth)
        let originX = (width - groupWidth) / 2
        var y: CGFloat = 0

        if let title = input.title {
            let textWidth = max(0, groupWidth - M.headerPaddingHorizontal * 2)
            let height = title.height(fitting: textWidth)
            header = CGRect(x: originX + M.headerPaddingHorizontal, y: M.headerPaddingTop, width: textWidth, height: height)
            y = M.headerPaddingTop + height + M.headerPaddingBottom
        } else {
            header = nil
            y = input.untitledPaddingTop ?? M.untitledPaddingTop
        }

        let cardWidth = Self.cardWidth(forWidth: width, maxWidth: input.maxWidth)
        var rowY: CGFloat = 0
        var rows: [CGRect] = []
        for row in input.rows {
            let height = row.height(fitting: cardWidth)
            rows.append(CGRect(x: 0, y: rowY, width: cardWidth, height: height))
            rowY += height
        }
        self.rows = rows
        card = CGRect(x: originX + M.cardMarginHorizontal, y: y, width: cardWidth, height: rowY)
        y = card.maxY

        if let footer = input.footer {
            let textWidth = max(0, groupWidth - M.footerPaddingHorizontal * 2)
            let height = footer.height(fitting: textWidth)
            self.footer = CGRect(x: originX + M.footerPaddingHorizontal, y: y + M.footerPaddingTop, width: textWidth, height: height)
            y += M.footerPaddingTop + height + M.footerPaddingBottom
        } else {
            self.footer = nil
        }
        size = CGSize(width: width, height: y + input.paddingBottom)
    }
}

/// A scrolling column of sections on the grouped background, like
/// components/ItemList.tsx. The scroll view does not adjust its own insets;
/// the safe area is applied here so the frames are fully determined.
public struct GroupedListLayout: Equatable, Sendable {
    public enum Metrics {
        public static let bottomPadding: CGFloat = 34
    }

    public struct Input {
        public var size: CGSize
        public var safeArea: LayoutInsets
        /// Each section's height at the list's content width.
        public var sections: [Measurable]

        public init(size: CGSize, safeArea: LayoutInsets, sections: [Measurable]) {
            self.size = size
            self.safeArea = safeArea
            self.sections = sections
        }
    }

    /// Section frames in the scroll view's content coordinates.
    public var sections: [CGRect]
    public var contentSize: CGSize

    public static func contentWidth(size: CGSize, safeArea: LayoutInsets) -> CGFloat {
        max(0, size.width - safeArea.horizontal)
    }

    public init(_ input: Input) {
        let width = Self.contentWidth(size: input.size, safeArea: input.safeArea)
        var y = input.safeArea.top
        var sections: [CGRect] = []
        for section in input.sections {
            let height = section.height(fitting: width)
            sections.append(CGRect(x: input.safeArea.left, y: y, width: width, height: height))
            y += height
        }
        self.sections = sections
        // Never shorter than the viewport, so the background fills it.
        let height = max(input.size.height, y + Metrics.bottomPadding + input.safeArea.bottom)
        contentSize = CGSize(width: max(0, input.size.width), height: height)
    }
}

/// The card at the top of Settings: the logotype on the surface colour.
/// From the logo branch of components/SettingsView.tsx.
public struct SettingsHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        public static let marginTop: CGFloat = 16
        public static let marginHorizontal: CGFloat = 16
        public static let paddingVertical: CGFloat = 24
        public static let logoSize = CGSize(width: 300, height: 90)
        public static let logoMarginBottom: CGFloat = 12
        /// Keeps the logo off the card's edges on narrow screens.
        public static let logoMinimumInset: CGFloat = 16
        public static let cornerRadius: CGFloat = 16
    }

    public var size: CGSize
    public var card: CGRect
    /// In the card's coordinates.
    public var logo: CGRect

    public init(width: CGFloat) {
        typealias M = Metrics
        let width = max(0, width)
        let cardWidth = max(0, width - M.marginHorizontal * 2)
        let logoWidth = min(M.logoSize.width, max(0, cardWidth - M.logoMinimumInset * 2))
        let logoHeight = logoWidth * M.logoSize.height / M.logoSize.width
        logo = CGRect(x: (cardWidth - logoWidth) / 2, y: M.paddingVertical, width: logoWidth, height: logoHeight)
        let cardHeight = M.paddingVertical + logoHeight + M.logoMarginBottom + M.paddingVertical
        card = CGRect(x: M.marginHorizontal, y: M.marginTop, width: cardWidth, height: cardHeight)
        size = CGSize(width: width, height: card.maxY)
    }
}

/// The revealed secret key under Settings › Backup: a small uppercase label
/// with a copy icon, then the key in monospace. From settings/account.tsx.
public struct SecretKeyCardLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingHorizontal: CGFloat = 16
        public static let paddingVertical: CGFloat = 14
        public static let headerMarginBottom: CGFloat = 10
        public static let iconSize: CGFloat = 18
        public static let labelIconSpacing: CGFloat = 8
    }

    public var size: CGSize
    public var label: CGRect
    public var icon: CGRect
    public var value: CGRect

    public init(width: CGFloat, label: Measurable, value: Measurable) {
        typealias M = Metrics
        let width = max(0, width)
        let innerWidth = max(0, width - M.paddingHorizontal * 2)
        let labelWidth = max(0, innerWidth - M.iconSize - M.labelIconSpacing)
        let labelHeight = label.height(fitting: labelWidth)
        let headerHeight = max(labelHeight, M.iconSize)
        let top = M.paddingVertical
        self.label = CGRect(x: M.paddingHorizontal, y: top + (headerHeight - labelHeight) / 2, width: labelWidth, height: labelHeight)
        icon = CGRect(
            x: width - M.paddingHorizontal - M.iconSize,
            y: top + (headerHeight - M.iconSize) / 2,
            width: M.iconSize,
            height: M.iconSize
        )
        let valueHeight = value.height(fitting: innerWidth)
        self.value = CGRect(x: M.paddingHorizontal, y: top + headerHeight + M.headerMarginBottom, width: innerWidth, height: valueHeight)
        size = CGSize(width: width, height: self.value.maxY + M.paddingVertical)
    }
}
