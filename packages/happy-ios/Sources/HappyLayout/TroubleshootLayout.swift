import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The top of app/(app)/troubleshoot.tsx: a heading, an intro and the
/// steps to check, each an icon beside a title, a body and optionally a
/// terminal block. It is one section of a grouped list.
public struct TroubleshootGuideLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingHorizontal: CGFloat = 24
        public static let paddingTop: CGFloat = 20
        public static let headingMarginBottom: CGFloat = 8
        public static let introMarginBottom: CGFloat = 24
        public static let iconWidth: CGFloat = 26
        public static let iconHeight: CGFloat = 22
        public static let iconSpacing: CGFloat = 12
        public static let stepTitleMarginBottom: CGFloat = 4
        public static let stepMarginBottom: CGFloat = 20
        public static let terminalMarginTop: CGFloat = 12
    }

    public struct Step {
        public var title: Measurable
        public var body: Measurable
        public var terminal: Measurable?

        public init(title: Measurable, body: Measurable, terminal: Measurable? = nil) {
            self.title = title
            self.body = body
            self.terminal = terminal
        }
    }

    public struct StepFrames: Equatable, Sendable {
        public var icon: CGRect
        public var title: CGRect
        public var body: CGRect
        public var terminal: CGRect?
    }

    public var size: CGSize
    public var heading: CGRect
    public var intro: CGRect
    public var steps: [StepFrames]

    /// `maxWidth` caps the centred block, like layout.maxWidth on a tablet.
    public init(width: CGFloat, maxWidth: CGFloat? = nil, heading: Measurable, intro: Measurable, steps: [Step]) {
        typealias M = Metrics
        let width = max(0, width)
        let blockWidth = maxWidth.map { min(width, $0) } ?? width
        let innerWidth = max(0, blockWidth - M.paddingHorizontal * 2)
        let x = (width - blockWidth) / 2 + M.paddingHorizontal

        self.heading = CGRect(x: x, y: M.paddingTop, width: innerWidth, height: heading.height(fitting: innerWidth))
        self.intro = CGRect(
            x: x,
            y: self.heading.maxY + M.headingMarginBottom,
            width: innerWidth,
            height: intro.height(fitting: innerWidth)
        )
        var y = self.intro.maxY + M.introMarginBottom
        let textX = x + M.iconWidth + M.iconSpacing
        let textWidth = max(0, innerWidth - M.iconWidth - M.iconSpacing)
        var frames: [StepFrames] = []
        for step in steps {
            let icon = CGRect(x: x, y: y, width: M.iconWidth, height: M.iconHeight)
            let title = CGRect(x: textX, y: y, width: textWidth, height: step.title.height(fitting: textWidth))
            let body = CGRect(
                x: textX,
                y: title.maxY + M.stepTitleMarginBottom,
                width: textWidth,
                height: step.body.height(fitting: textWidth)
            )
            let terminal = step.terminal.map {
                CGRect(x: textX, y: body.maxY + M.terminalMarginTop, width: textWidth, height: $0.height(fitting: textWidth))
            }
            frames.append(StepFrames(icon: icon, title: title, body: body, terminal: terminal))
            y = max(icon.maxY, terminal?.maxY ?? body.maxY) + M.stepMarginBottom
        }
        self.steps = frames
        size = CGSize(width: width, height: y)
    }
}

/// The bottom of the troubleshoot screen: Copy AI prompt, centred, with a
/// hint under it.
public struct CopyPromptLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingTop: CGFloat = 20
        public static let paddingHorizontal: CGFloat = 24
        public static let buttonWidth: CGFloat = 260
        public static let hintMarginTop: CGFloat = 8
    }

    public var size: CGSize
    public var button: CGRect
    public var hint: CGRect

    public init(width: CGFloat, maxWidth: CGFloat? = nil, button: Measurable, hint: Measurable) {
        typealias M = Metrics
        let width = max(0, width)
        let blockWidth = maxWidth.map { min(width, $0) } ?? width
        let innerWidth = max(0, blockWidth - M.paddingHorizontal * 2)
        let x = (width - blockWidth) / 2 + M.paddingHorizontal
        let buttonWidth = min(M.buttonWidth, innerWidth)
        self.button = CGRect(
            x: x + (innerWidth - buttonWidth) / 2,
            y: M.paddingTop,
            width: buttonWidth,
            height: button.height(fitting: buttonWidth)
        )
        self.hint = CGRect(
            x: x,
            y: self.button.maxY + M.hintMarginTop,
            width: innerWidth,
            height: hint.height(fitting: innerWidth)
        )
        size = CGSize(width: width, height: self.hint.maxY)
    }
}
