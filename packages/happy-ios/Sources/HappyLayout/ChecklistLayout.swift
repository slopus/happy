import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// One row of an onboarding checklist, from ChecklistRow in
/// components/onboarding/OnboardingContent.tsx: a box and a title side by
/// side in a tappable head, then an optional body indented under the title.
/// Ticking the box changes only its image, never these frames.
public struct ChecklistRowLayout: Equatable, Sendable {
    public enum Metrics {
        public static let headMinHeight: CGFloat = 32
        public static let boxSize: CGFloat = 26
        public static let boxSpacing: CGFloat = 12
        public static let bodyPaddingLeft: CGFloat = 38
        public static let bodyPaddingTop: CGFloat = 6
        /// Under every row but the last.
        public static let marginBottom: CGFloat = 20
    }

    /// The tappable head: box and title.
    public var head: CGRect
    public var box: CGRect
    public var title: CGRect
    public var body: CGRect?

    public var maxY: CGFloat {
        body?.maxY ?? head.maxY
    }

    public init(origin: CGPoint, width: CGFloat, title: Measurable, body: Measurable?) {
        typealias M = Metrics
        let width = max(0, width)
        let textX = origin.x + M.boxSize + M.boxSpacing
        let textWidth = max(0, width - M.boxSize - M.boxSpacing)
        let titleHeight = title.height(fitting: textWidth)
        let headHeight = max(M.headMinHeight, titleHeight, M.boxSize)
        head = CGRect(x: origin.x, y: origin.y, width: width, height: headHeight)
        box = CGRect(x: origin.x, y: origin.y + (headHeight - M.boxSize) / 2, width: M.boxSize, height: M.boxSize)
        self.title = CGRect(x: textX, y: origin.y + (headHeight - titleHeight) / 2, width: textWidth, height: titleHeight)
        self.body = body.map {
            let bodyWidth = max(0, width - M.bodyPaddingLeft)
            return CGRect(
                x: origin.x + M.bodyPaddingLeft,
                y: head.maxY + M.bodyPaddingTop,
                width: bodyWidth,
                height: $0.height(fitting: bodyWidth)
            )
        }
    }
}

/// A few shell lines the way happy.engineering draws them, from
/// components/onboarding/TerminalBlock.tsx. The border sits inside the
/// frame and the padding inside the border, as in React Native.
public struct TerminalBlockLayout: Equatable, Sendable {
    public enum Metrics {
        public static let borderWidth: CGFloat = 1
        public static let paddingVertical: CGFloat = 14
        public static let paddingHorizontal: CGFloat = 18
        public static let cornerRadius: CGFloat = 14
    }

    public var size: CGSize
    public var lines: [CGRect]

    public init(width: CGFloat, lines: [Measurable]) {
        typealias M = Metrics
        let width = max(0, width)
        let x = M.borderWidth + M.paddingHorizontal
        let lineWidth = max(0, width - x * 2)
        var y = M.borderWidth + M.paddingVertical
        var frames: [CGRect] = []
        for line in lines {
            let frame = CGRect(x: x, y: y, width: lineWidth, height: line.height(fitting: lineWidth))
            frames.append(frame)
            y = frame.maxY
        }
        self.lines = frames
        size = CGSize(width: width, height: y + M.paddingVertical + M.borderWidth)
    }
}

/// The checklist when every linked computer is offline, from
/// LinkComputerChecklist in components/onboarding/LinkComputer.tsx:
///   - a title naming the computer;
///   - a ticked "Linked …" row;
///   - an "Open Happy" row whose body is a line of text and a terminal block;
///   - the action buttons, 260 wide and stacked on the left.
///
/// It stands in for the session list, so it scrolls from the top instead of
/// centring like the first-run screens.
public struct OfflineChecklistLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingTop: CGFloat = 16
        public static let paddingBottom: CGFloat = 48
        public static let contentMaxWidth: CGFloat = 480
        public static let contentPaddingHorizontal: CGFloat = 24
        public static let titlePaddingHorizontal: CGFloat = 4
        public static let titleMarginBottom: CGFloat = 16
        public static let terminalMarginTop: CGFloat = 12
        public static let actionsMarginTop: CGFloat = 6
        public static let buttonWidth: CGFloat = 260
        public static let buttonMarginBottom: CGFloat = 8
    }

    public struct Input {
        public var size: CGSize
        /// Includes the navigation bar at the top.
        public var safeArea: LayoutInsets
        public var title: Measurable
        public var linkedTitle: Measurable
        public var openTitle: Measurable
        public var openBody: Measurable
        public var terminal: Measurable
        public var buttons: [Measurable]

        public init(
            size: CGSize,
            safeArea: LayoutInsets,
            title: Measurable,
            linkedTitle: Measurable,
            openTitle: Measurable,
            openBody: Measurable,
            terminal: Measurable,
            buttons: [Measurable]
        ) {
            self.size = size
            self.safeArea = safeArea
            self.title = title
            self.linkedTitle = linkedTitle
            self.openTitle = openTitle
            self.openBody = openBody
            self.terminal = terminal
            self.buttons = buttons
        }
    }

    /// Everything below is in the scroll view's content coordinates; the
    /// scroll view fills the screen.
    public var contentSize: CGSize
    public var title: CGRect
    public var linked: ChecklistRowLayout
    public var open: ChecklistRowLayout
    public var openBody: CGRect
    public var terminal: CGRect
    public var buttons: [CGRect]

    public init(_ input: Input) {
        typealias M = Metrics
        let insets = input.safeArea
        let bodyWidth = max(0, input.size.width - insets.horizontal)
        let contentWidth = min(M.contentMaxWidth, bodyWidth)
        let innerWidth = max(0, contentWidth - M.contentPaddingHorizontal * 2)
        let innerX = insets.left + (bodyWidth - contentWidth) / 2 + M.contentPaddingHorizontal

        var y = insets.top + M.paddingTop
        let titleWidth = max(0, innerWidth - M.titlePaddingHorizontal * 2)
        title = CGRect(x: innerX + M.titlePaddingHorizontal, y: y, width: titleWidth, height: input.title.height(fitting: titleWidth))
        y = title.maxY + M.titleMarginBottom

        linked = ChecklistRowLayout(origin: CGPoint(x: innerX, y: y), width: innerWidth, title: input.linkedTitle, body: nil)
        y = linked.maxY + ChecklistRowLayout.Metrics.marginBottom

        let text = input.openBody
        let terminal = input.terminal
        let body = Measurable { width in
            CGSize(width: width, height: text.height(fitting: width) + M.terminalMarginTop + terminal.height(fitting: width))
        }
        open = ChecklistRowLayout(origin: CGPoint(x: innerX, y: y), width: innerWidth, title: input.openTitle, body: body)
        let bodyFrame = open.body ?? .zero
        openBody = CGRect(x: bodyFrame.minX, y: bodyFrame.minY, width: bodyFrame.width, height: text.height(fitting: bodyFrame.width))
        self.terminal = CGRect(
            x: bodyFrame.minX,
            y: openBody.maxY + M.terminalMarginTop,
            width: bodyFrame.width,
            height: terminal.height(fitting: bodyFrame.width)
        )
        y = open.maxY + M.actionsMarginTop

        let buttonWidth = min(M.buttonWidth, innerWidth)
        var buttons: [CGRect] = []
        for button in input.buttons {
            let frame = CGRect(x: innerX, y: y, width: buttonWidth, height: button.height(fitting: buttonWidth))
            buttons.append(frame)
            y = frame.maxY + M.buttonMarginBottom
        }
        self.buttons = buttons
        contentSize = CGSize(
            width: max(0, input.size.width),
            height: max(input.size.height, y + M.paddingBottom + insets.bottom)
        )
    }
}

/// A spinner centred in what is left of the screen, like the one
/// SessionsListWrapper shows until the account's data is ready.
public struct LoadingLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingBottom: CGFloat = 32
    }

    public var spinner: CGRect

    public init(size: CGSize, safeArea: LayoutInsets, spinner: CGSize) {
        let left = safeArea.left
        let width = max(0, size.width - safeArea.horizontal)
        let top = safeArea.top
        let height = max(0, size.height - safeArea.bottom - Metrics.paddingBottom - top)
        self.spinner = CGRect(
            x: left + (width - spinner.width) / 2,
            y: top + (height - spinner.height) / 2,
            width: spinner.width,
            height: spinner.height
        )
    }
}
