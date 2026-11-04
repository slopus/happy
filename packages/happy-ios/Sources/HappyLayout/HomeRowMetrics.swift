import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// What the home rows' plans read beside their text: a flat session's
/// lines, the glyph boxes and the hairline, as the screen renders them.
/// Read from the text styles and the screen, so a different font, text
/// size or scale gives different values.
public struct HomeRowMetrics: Hashable, Sendable {
    /// The desktop glyph's box beside a computer's name.
    public var machineIcon: CGSize
    /// One device pixel.
    public var hairline: CGFloat
    /// A flat session's title, project, workspace and line counts' lines.
    public var sessionLines: FlatSessionRowLayout.Lines
    /// The branch glyph's box beside a workspace.
    public var branchIcon: CGSize

    public init(
        machineIcon: CGSize,
        hairline: CGFloat,
        sessionLines: FlatSessionRowLayout.Lines = .designed,
        branchIcon: CGSize = CGSize(width: FlatSessionRowLayout.Metrics.branchIconSize, height: FlatSessionRowLayout.Metrics.branchIconSize)
    ) {
        self.machineIcon = machineIcon
        self.hairline = hairline
        self.sessionLines = sessionLines
        self.branchIcon = branchIcon
    }
}

/// HomeListHeader.tsx's notices, sized without views: each is an ItemGroup
/// (4 above, 16 below) around one Item with an icon, a one-line title, a
/// subtitle and the chevron.
public enum HomeBannerHeights {
    public enum Metrics {
        /// HomeListHeaderView's `untitledPaddingTop` and `paddingBottom`.
        public static let groupPaddingTop: CGFloat = 4
        public static let groupPaddingBottom: CGFloat = 16
    }

    /// One notice's text, measured however the caller measures it.
    public struct Banner {
        public var title: Measurable
        public var subtitle: Measurable
        /// The Happy Desktop card (`DesktopCardLayout`) instead of an Item.
        public var desktopCard: Bool

        public init(title: Measurable, subtitle: Measurable, desktopCard: Bool = false) {
            self.title = title
            self.subtitle = subtitle
            self.desktopCard = desktopCard
        }
    }

    /// One notice, group padding included.
    public static func banner(_ banner: Banner, width: CGFloat, maxWidth: CGFloat?, chevron: CGSize) -> CGFloat {
        let row = Measurable { rowWidth in
            if banner.desktopCard {
                return DesktopCardLayout(width: rowWidth, title: banner.title, body: banner.subtitle).size
            }
            return ItemRowLayout(.init(
                width: rowWidth,
                hasIcon: true,
                title: banner.title,
                subtitle: banner.subtitle,
                accessory: chevron
            )).size
        }
        return ItemGroupLayout(.init(
            width: width,
            rows: [row],
            maxWidth: maxWidth,
            untitledPaddingTop: Metrics.groupPaddingTop,
            paddingBottom: Metrics.groupPaddingBottom
        )).size.height
    }

    /// The notices stacked; 0 for none.
    public static func header(_ banners: [Banner], width: CGFloat, maxWidth: CGFloat?, chevron: CGSize) -> CGFloat {
        HomeListHeaderLayout(
            width: width,
            banners: banners.map { banner in
                Measurable { width in
                    CGSize(width: width, height: Self.banner(banner, width: width, maxWidth: maxWidth, chevron: chevron))
                }
            }
        ).size.height
    }
}
