import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Settings › Inference › an account › Sign in again: one settings card
/// holding the sign-in, and three buttons under it. Every state (starting,
/// a device code, Claude's pasted code, signed in, failed) fills the same
/// places, so nothing moves as the sign-in goes on; only what is in them
/// changes. Each place is sized for the most it may hold: two lines of
/// heading, four of message (a code, the paste field and the message share
/// one place), one of status.
///
///     ╭──────────────────────────────╮
///     │          Work ChatGPT        │  name, one line
///     │  Enter this code on the …    │  heading, two lines
///     │          FQ7K-2MXD           │  code │ field │ message
///     │              ◌               │  spinner
///     │  Waiting for you to finish…  │  status, one line
///     ╰──────────────────────────────╯
///     (            Copy            )
///     (      Open sign-in page     )
///     (           Cancel           )
public struct AccountSignInLayout: Equatable, Sendable {
    public enum Metrics {
        /// The card's sides and corners are a settings card's.
        public static let side = SettingsLayout.Metrics.side
        public static let radius = SettingsLayout.Metrics.radius
        public static let top: CGFloat = 28
        public static let padding: CGFloat = 20
        public static let nameGap: CGFloat = 8
        public static let headingGap: CGFloat = 16
        public static let middleGap: CGFloat = 16
        public static let spinner: CGFloat = 20
        public static let spinnerGap: CGFloat = 6
        /// The paste field's own height, at least.
        public static let field: CGFloat = 44
        public static let buttonsTop: CGFloat = 24
        public static let buttonGap: CGFloat = 12
        public static let headingLines: CGFloat = 2
        public static let messageLines: CGFloat = 4
    }

    public struct Input: Equatable, Sendable {
        public var width: CGFloat
        public var safeArea: LayoutInsets
        /// One line of each style, at the person's text size.
        public var nameLine: CGFloat
        public var headingLine: CGFloat
        public var codeLine: CGFloat
        public var messageLine: CGFloat
        public var statusLine: CGFloat
        public var button: CGFloat

        public init(width: CGFloat, safeArea: LayoutInsets, nameLine: CGFloat, headingLine: CGFloat, codeLine: CGFloat,
                    messageLine: CGFloat, statusLine: CGFloat, button: CGFloat) {
            self.width = width; self.safeArea = safeArea
            self.nameLine = nameLine; self.headingLine = headingLine; self.codeLine = codeLine
            self.messageLine = messageLine; self.statusLine = statusLine; self.button = button
        }
    }

    public var card: CGRect
    public var name: CGRect
    public var heading: CGRect
    /// Where the code, the paste field or the message goes.
    public var middle: CGRect
    /// The paste field, centred in `middle`.
    public var field: CGRect
    public var spinner: CGRect
    public var status: CGRect
    /// Three, top to bottom: a slot with nothing in it keeps its place.
    public var buttons: [CGRect]
    public var height: CGFloat

    public init(_ input: Input) {
        typealias M = Metrics
        let left = input.safeArea.left + M.side
        let cardWidth = max(0, input.width - input.safeArea.left - input.safeArea.right - 2 * M.side)
        let inner = max(0, cardWidth - 2 * M.padding)
        let x = left + M.padding
        var y = input.safeArea.top + M.top + M.padding
        name = CGRect(x: x, y: y, width: inner, height: input.nameLine)
        y = name.maxY + M.nameGap
        heading = CGRect(x: x, y: y, width: inner, height: input.headingLine * M.headingLines)
        y = heading.maxY + M.headingGap
        middle = CGRect(x: x, y: y, width: inner, height: max(input.messageLine * M.messageLines, input.codeLine, M.field))
        field = CGRect(x: x, y: middle.midY - M.field / 2, width: inner, height: M.field)
        y = middle.maxY + M.middleGap
        spinner = CGRect(x: x + (inner - M.spinner) / 2, y: y, width: M.spinner, height: M.spinner)
        status = CGRect(x: x, y: spinner.maxY + M.spinnerGap, width: inner, height: input.statusLine)
        card = CGRect(x: left, y: input.safeArea.top + M.top, width: cardWidth, height: status.maxY + M.padding - input.safeArea.top - M.top)
        y = card.maxY + M.buttonsTop
        var buttons: [CGRect] = []
        for _ in 0..<3 {
            buttons.append(CGRect(x: left, y: y, width: cardWidth, height: input.button))
            y += input.button + M.buttonGap
        }
        self.buttons = buttons
        height = y - M.buttonGap + input.safeArea.bottom
    }
}
