import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The migration screen (DesktopMigrationViewController), in the first-run
/// screens' look (`InstallDesktopLayout`): their column, 24 in from the safe
/// area and at most 440 wide; the path's picture where their animated TV
/// is; the title and its line centred in a slide's type; Scan QR code
/// centred, as wide as its label (at least 200), Learn more and the
/// server's section under it, closed at the foot of the window while
/// everything fits; and a site's 40 tall target.
///
///     picture                        centred
///     16
///     title                          centred
///     8
///     line                           centred
///     20
///     before and after               the column's width (direct only)
///     20
///     ① step                         the number's dot, then the words
///        Download from happy.engineering   (a step's link, under it)
///     12
///     ② step
///     20 at least
///     Scan QR code                   centred
///     4
///     Learn more                     centred
///     8
///     Running Happy on a server? ⌄   the column's width; closed, its foot
///                                    on the safe area's; open, it scrolls
///
/// Taller than the window, it scrolls, the button after the words.
public struct MigrationScreenLayout: Equatable, Sendable {
    public enum Metrics {
        public static let sidePadding: CGFloat = StartLayout.Metrics.sidePadding
        public static let columnMaxWidth: CGFloat = StartLayout.Metrics.columnMaxWidth
        public static let art: CGFloat = 72
        public static let artGap: CGFloat = 16
        public static let titleGap: CGFloat = StartLayout.Metrics.titleGap
        public static let sectionGap: CGFloat = 20
        public static let number: CGFloat = 22
        public static let numberRadius: CGFloat = 11
        /// Down from the step's top, so the dot sits level with its first
        /// line (24 tall).
        public static let numberOffset: CGFloat = 1
        public static let numberGap: CGFloat = 12
        public static let stepGap: CGFloat = 12
        public static let buttonGap: CGFloat = 20
        public static let learnMoreGap: CGFloat = 4
        public static let serverGap: CGFloat = 8
        public static let buttonMinWidth: CGFloat = StartLayout.Metrics.buttonMinWidth
        /// A link's target, as a text action's (`TextActionLayout`).
        public static let linkMinHeight: CGFloat = TextActionLayout.Metrics.minHeight
        public static let linkPadding: CGFloat = TextActionLayout.Metrics.paddingHorizontal
    }

    public struct Step {
        /// The step's number, drawn in its dot.
        public var number: Measurable
        public var text: Measurable
        public var link: Measurable?

        public init(number: Measurable, text: Measurable, link: Measurable? = nil) {
            self.number = number
            self.text = text
            self.link = link
        }
    }

    /// A link's target and, in it, its label.
    public struct Link: Equatable, Sendable {
        public var target: CGRect
        public var label: CGRect
    }

    public struct StepFrames: Equatable, Sendable {
        /// The dot, and the number centred in it (in the dot's space).
        public var number: CGRect
        public var numberLabel: CGRect
        public var text: CGRect
        public var link: Link?
    }

    public var art: CGRect
    public var title: CGRect
    public var body: CGRect
    public var diagram: CGRect?
    public var steps: [StepFrames]
    public var section: CGRect
    public var button: CGRect
    public var learnMore: Link
    public var contentHeight: CGFloat

    /// `safeArea` includes the bar. `button` is Scan QR code's own size.
    /// `sectionHeader` is the server's section closed, `section` as it is.
    public init(size: CGSize, safeArea: LayoutInsets, title: Measurable, body: Measurable, diagram: Measurable?, steps: [Step], section: Measurable, sectionHeader: Measurable, button buttonSize: CGSize, learnMore: Measurable) {
        typealias M = Metrics
        let width = max(0, size.width - safeArea.horizontal)
        let viewport = max(0, size.height - safeArea.vertical)
        let column = min(M.columnMaxWidth, max(0, width - M.sidePadding * 2))
        let x = safeArea.left + (width - column) / 2
        func centred(_ size: CGSize, _ y: CGFloat) -> CGRect {
            CGRect(x: x + (column - size.width) / 2, y: y, width: size.width, height: size.height)
        }
        /// A link whose words start at `x`, the target's padding outside them.
        func makeLink(_ label: Measurable, x: CGFloat, y: CGFloat, width: CGFloat) -> Link {
            let size = label.size(fitting: max(0, width))
            let target = CGRect(x: x - M.linkPadding, y: y, width: size.width + M.linkPadding * 2, height: max(M.linkMinHeight, size.height))
            return Link(target: target, label: CGRect(x: M.linkPadding, y: (target.height - size.height) / 2, width: size.width, height: size.height))
        }

        self.art = centred(CGSize(width: M.art, height: M.art), safeArea.top)
        var y = self.art.maxY + M.artGap
        self.title = centred(title.size(fitting: column), y)
        y = self.title.maxY + M.titleGap
        self.body = centred(body.size(fitting: column), y)
        y = self.body.maxY + M.sectionGap
        if let diagram {
            let frame = CGRect(x: x, y: y, width: column, height: diagram.height(fitting: column))
            self.diagram = frame
            y = frame.maxY + M.sectionGap
        } else {
            self.diagram = nil
        }
        let textX = x + M.number + M.numberGap
        let textWidth = max(0, column - M.number - M.numberGap)
        var frames: [StepFrames] = []
        for (index, step) in steps.enumerated() {
            if index > 0 { y += M.stepGap }
            let text = CGRect(x: textX, y: y, width: textWidth, height: step.text.height(fitting: textWidth))
            let link = step.link.map { makeLink($0, x: textX, y: text.maxY, width: textWidth - M.linkPadding * 2) }
            let label = step.number.size(fitting: M.number)
            frames.append(StepFrames(
                number: CGRect(x: x, y: y + M.numberOffset, width: M.number, height: M.number),
                numberLabel: CGRect(x: (M.number - label.width) / 2, y: (M.number - label.height) / 2, width: label.width, height: label.height),
                text: text,
                link: link
            ))
            y = max(text.maxY, link?.target.maxY ?? 0)
        }
        self.steps = frames
        let buttonWidth = min(column, max(M.buttonMinWidth, buttonSize.width))
        let learnSize = learnMore.size(fitting: max(0, column - M.linkPadding * 2))
        let learnHeight = max(M.linkMinHeight, learnSize.height)
        let closed = sectionHeader.height(fitting: column)
        let lowest = safeArea.top + viewport - closed - M.serverGap - learnHeight - M.learnMoreGap - buttonSize.height
        self.button = centred(CGSize(width: buttonWidth, height: buttonSize.height), max(y + M.buttonGap, lowest))
        var learn = makeLink(learnMore, x: 0, y: self.button.maxY + M.learnMoreGap, width: column - M.linkPadding * 2)
        learn.target.origin.x = x + (column - learn.target.width) / 2
        self.learnMore = learn
        self.section = CGRect(x: x, y: learn.target.maxY + M.serverGap, width: column, height: section.height(fitting: column))
        contentHeight = max(size.height, self.section.maxY + safeArea.bottom)
    }
}
