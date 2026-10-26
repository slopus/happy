import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The first-run template shared by Welcome and Link Your Computer, from
/// components/onboarding/OnboardingScreen.tsx: a centred block of content,
/// a large primary button and a text action under it, with Get help in the
/// bottom-right corner.
///
/// The content and secondary slots are measured as the largest of every
/// alternative they can show (`Measurable.largest(of:)`), so the buttons land
/// in the same place on both screens.
public struct OnboardingLayout: Equatable, Sendable {
    public enum Metrics {
        public static let blockMaxWidth: CGFloat = 480
        public static let blockPaddingHorizontal: CGFloat = 24
        public static let bodyPaddingVertical: CGFloat = 8
        public static let primaryMarginTop: CGFloat = 12
        public static let secondaryMarginTop: CGFloat = 4
        /// Between glass buttons, which are pills where text actions are not.
        public static let glassActionGap: CGFloat = 12
        public static let footerPaddingHorizontal: CGFloat = 16
        public static let footerPaddingBottom: CGFloat = 12
        /// Above and below an accessory over the primary button.
        public static let accessoryGap: CGFloat = 16
    }

    public struct Input {
        public var size: CGSize
        /// Includes the navigation bar at the top and the home indicator at
        /// the bottom.
        public var safeArea: LayoutInsets
        public var content: Measurable
        public var primary: Measurable
        public var secondary: Measurable
        /// A second text action under the first, where a screen has one.
        public var tertiary: Measurable?
        public var help: CGSize
        /// The actions are glass pills, spaced as pills.
        public var glass = false
        /// The height of a control the screen holds just above its primary
        /// button, across the block (the link sheet's Relay | Direct).
        public var accessory: CGFloat?

        public init(size: CGSize, safeArea: LayoutInsets, content: Measurable, primary: Measurable, secondary: Measurable, tertiary: Measurable? = nil, help: CGSize) {
            self.size = size
            self.safeArea = safeArea
            self.content = content
            self.primary = primary
            self.secondary = secondary
            self.tertiary = tertiary
            self.help = help
        }
    }

    /// The scroll view, in the screen's coordinates.
    public var scroll: CGRect
    public var contentSize: CGSize
    /// Content, primary and secondary, in the scroll view's coordinates.
    public var content: CGRect
    public var primary: CGRect
    public var secondary: CGRect
    /// The accessory, as wide as the buttons, in the scroll view's coordinates.
    public var accessory: CGRect?
    /// Under the secondary, as far below it as it is below the primary.
    public var tertiary: CGRect?
    /// Get help, in the screen's coordinates.
    public var help: CGRect

    /// The width the content, primary and secondary are laid out at.
    public static func blockWidth(size: CGSize, safeArea: LayoutInsets) -> CGFloat {
        let bodyWidth = max(0, size.width - safeArea.horizontal)
        return max(0, min(Metrics.blockMaxWidth, bodyWidth) - Metrics.blockPaddingHorizontal * 2)
    }

    public init(_ input: Input) {
        typealias M = Metrics
        let size = input.size
        let insets = input.safeArea

        help = CGRect(
            x: size.width - insets.right - M.footerPaddingHorizontal - input.help.width,
            y: size.height - insets.bottom - M.footerPaddingBottom - input.help.height,
            width: input.help.width,
            height: input.help.height
        )
        scroll = CGRect(x: 0, y: insets.top, width: size.width, height: max(0, help.minY - insets.top))

        let bodyWidth = max(0, size.width - insets.horizontal)
        let blockWidth = min(M.blockMaxWidth, bodyWidth)
        let innerWidth = Self.blockWidth(size: size, safeArea: insets)
        let innerX = insets.left + (bodyWidth - blockWidth) / 2 + M.blockPaddingHorizontal

        let contentHeight = input.content.height(fitting: innerWidth)
        let primaryHeight = input.primary.height(fitting: innerWidth)
        let secondaryHeight = input.secondary.height(fitting: innerWidth)
        let tertiaryHeight = input.tertiary?.height(fitting: innerWidth)
        let gap = input.glass ? M.glassActionGap : M.secondaryMarginTop
        let accessoryBand = input.accessory.map { M.accessoryGap + $0 + M.accessoryGap } ?? M.primaryMarginTop
        let blockHeight = contentHeight + accessoryBand + primaryHeight + gap + secondaryHeight
            + (tertiaryHeight.map { gap + $0 } ?? 0)

        // Two growing spacers centre the block; when it does not fit, the
        // body scrolls instead.
        let free = max(0, scroll.height - M.bodyPaddingVertical * 2 - blockHeight)
        var y = M.bodyPaddingVertical + free / 2
        content = CGRect(x: innerX, y: y, width: innerWidth, height: contentHeight)
        if let height = input.accessory {
            let accessory = CGRect(x: innerX, y: content.maxY + M.accessoryGap, width: innerWidth, height: height)
            self.accessory = accessory
            y = accessory.maxY + M.accessoryGap
        } else {
            accessory = nil
            y = content.maxY + M.primaryMarginTop
        }
        primary = CGRect(x: innerX, y: y, width: innerWidth, height: primaryHeight)
        y = primary.maxY + gap
        let secondary = CGRect(x: innerX, y: y, width: innerWidth, height: secondaryHeight)
        let tertiary = tertiaryHeight.map { CGRect(x: innerX, y: secondary.maxY + gap, width: innerWidth, height: $0) }
        self.secondary = secondary
        self.tertiary = tertiary
        contentSize = CGSize(width: size.width, height: max(scroll.height, (tertiary ?? secondary).maxY + M.bodyPaddingVertical))
    }
}

/// The Get help pill: a help icon, then the label.
public struct GetHelpButtonLayout: Equatable, Sendable {
    public enum Metrics {
        public static let minHeight: CGFloat = 36
        public static let paddingHorizontal: CGFloat = 12
        public static let iconSize: CGFloat = 17
        public static let spacing: CGFloat = 6
        public static let cornerRadius: CGFloat = 18
        public static let hitSlop: CGFloat = 8
    }

    public var size: CGSize
    /// The icon's slot: its width, the pill's full height. The icon centres
    /// itself in it (`IconView`), as `alignItems: 'center'` centres it in
    /// the row.
    public var icon: CGRect
    public var label: CGRect

    /// `label` is the label's single-line size.
    public init(label: CGSize) {
        typealias M = Metrics
        let height = max(M.minHeight, label.height, M.iconSize)
        icon = CGRect(x: M.paddingHorizontal, y: 0, width: M.iconSize, height: height)
        self.label = CGRect(x: icon.maxX + M.spacing, y: (height - label.height) / 2, width: label.width, height: label.height)
        size = CGSize(width: self.label.maxX + M.paddingHorizontal, height: height)
    }
}

/// The "Happy / Engineering" wordmark above the welcome headline.
public enum WordmarkMetrics {
    public static let height: CGFloat = 84
    /// Width over height of the wordmark's view box.
    public static let aspectRatio: CGFloat = 5274 / 1932

    /// RN rounds the width: round(84 × 5274 / 1932) = 229.
    public static func size(height: CGFloat = height) -> CGSize {
        CGSize(width: (height * aspectRatio).rounded(), height: height)
    }
}

/// Welcome: the wordmark, the headline and the three value props, from
/// WelcomeContent in components/onboarding/OnboardingContent.tsx.
public struct WelcomeContentLayout: Equatable, Sendable {
    public enum Metrics {
        public static let titleMarginTop: CGFloat = 28
        public static let propsMarginTop: CGFloat = 12
        public static let propsPaddingBottom: CGFloat = 12
    }

    public var size: CGSize
    public var wordmark: CGRect
    public var title: CGRect
    public var props: [CGRect]

    public init(width: CGFloat, title: Measurable, props: [Measurable]) {
        typealias M = Metrics
        let width = max(0, width)
        var mark = WordmarkMetrics.size()
        if mark.width > width, mark.width > 0 {
            // Scale down rather than overflow on a very narrow screen.
            mark = CGSize(width: width, height: mark.height * width / mark.width)
        }
        wordmark = CGRect(origin: .zero, size: mark)
        let titleHeight = title.height(fitting: width)
        self.title = CGRect(x: 0, y: wordmark.maxY + M.titleMarginTop, width: width, height: titleHeight)
        var y = self.title.maxY + M.propsMarginTop
        var frames: [CGRect] = []
        for prop in props {
            let height = prop.height(fitting: width)
            frames.append(CGRect(x: 0, y: y, width: width, height: height))
            y += height
        }
        self.props = frames
        size = CGSize(width: width, height: y + M.propsPaddingBottom)
    }
}

/// Link Your Computer: the title, a two-step checklist and a reserved error
/// line, from LinkComputerContent in OnboardingContent.tsx.
public struct LinkComputerContentLayout: Equatable, Sendable {
    public enum Metrics {
        public static let checklistMarginTop: CGFloat = 24
        public static let errorMarginTop: CGFloat = 16
    }

    public struct Row {
        public var title: Measurable
        public var body: Measurable?

        public init(title: Measurable, body: Measurable? = nil) {
            self.title = title
            self.body = body
        }
    }

    public var size: CGSize
    public var title: CGRect
    public var rows: [ChecklistRowLayout]
    /// Always reserved, one line high, so an error never moves the buttons.
    public var error: CGRect

    /// `errorLineHeight` is one line of the error style.
    public init(width: CGFloat, title: Measurable, rows: [Row], errorLineHeight: CGFloat) {
        typealias M = Metrics
        let width = max(0, width)
        let titleHeight = title.height(fitting: width)
        self.title = CGRect(x: 0, y: 0, width: width, height: titleHeight)

        var y = self.title.maxY + M.checklistMarginTop
        var frames: [ChecklistRowLayout] = []
        for (index, row) in rows.enumerated() {
            let frame = ChecklistRowLayout(origin: CGPoint(x: 0, y: y), width: width, title: row.title, body: row.body)
            frames.append(frame)
            y = frame.maxY
            if index < rows.count - 1 {
                y += ChecklistRowLayout.Metrics.marginBottom
            }
        }
        self.rows = frames
        error = CGRect(x: 0, y: y + M.errorMarginTop, width: width, height: errorLineHeight)
        size = CGSize(width: width, height: error.maxY)
    }
}

/// A navigation bar title view: an optional title over an optional
/// subtitle (the custom server's host), both centred and one line.
public struct NavigationTitleLayout: Equatable, Sendable {
    public var size: CGSize
    public var title: CGRect?
    public var subtitle: CGRect?

    /// `title` and `subtitle` are single-line sizes, `maxWidth` what the bar
    /// leaves for the title.
    public init(title: CGSize?, subtitle: CGSize?, maxWidth: CGFloat) {
        let maxWidth = max(0, maxWidth)
        let titleWidth = min(title?.width ?? 0, maxWidth)
        let subtitleWidth = min(subtitle?.width ?? 0, maxWidth)
        let width = max(titleWidth, subtitleWidth)
        let titleHeight = title?.height ?? 0
        self.title = title.map { _ in CGRect(x: (width - titleWidth) / 2, y: 0, width: titleWidth, height: titleHeight) }
        self.subtitle = subtitle.map {
            CGRect(x: (width - subtitleWidth) / 2, y: titleHeight, width: subtitleWidth, height: $0.height)
        }
        size = CGSize(width: width, height: titleHeight + (subtitle?.height ?? 0))
    }
}
