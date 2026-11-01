import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A single line for the account picture, name and menu chevron. While the
/// account isn't live the name gives way to the link's status, a spinner
/// and its words ("Connecting…"), in the name's place: the picture stays,
/// the pair starts where the name did, centred on its line, and the
/// chevron follows whichever is shown.
///
///     (◉ Steve ⌄)   →   (◉ ⟳ Connecting… ⌄)
public struct AccountSwitcherLayout: Equatable, Sendable {
    public enum Metrics {
        public static let height: CGFloat = 36
        /// The glass capsule's inset around what it holds.
        public static let leading: CGFloat = 4
        public static let trailing: CGFloat = 10
        public static let picture: CGFloat = 28
        public static let pictureGap: CGFloat = 8
        public static let chevronGap: CGFloat = 4
        /// The status's spinner (the system's, drawn this size) and the
        /// room between it and the words.
        public static let spinner: CGFloat = 16
        public static let spinnerGap: CGFloat = 6
        /// How far the name and the status slide as one gives way to the
        /// other (Telegram's title does the same).
        public static let slide: CGFloat = 6
        /// The bar's own glass round the 36 line on every side, its
        /// buttons' 44: room the switcher leaves it.
        public static let barGlassOutset: CGFloat = 4
    }

    /// The status's measured parts: the spinner's side and its words on one line.
    public struct Status: Equatable, Sendable {
        public var spinner: CGSize
        public var text: CGSize

        public init(spinner: CGSize, text: CGSize) {
            self.spinner = spinner
            self.text = text
        }
    }

    /// Which of the two is shown: the switcher is as wide as that one.
    public enum Showing: Equatable, Sendable {
        case title, status
    }

    public var size: CGSize
    public var picture: CGRect
    /// Where the name is, shown or not, so a fade between the two has both.
    public var title: CGRect
    /// The status's spinner and words; zero while there is no status.
    public var spinner: CGRect
    public var status: CGRect
    public var chevron: CGRect

    /// Space left for the switcher after the navigation bar's margins,
    /// its trailing actions and the glass the bar draws round the switcher.
    public static func availableWidth(barWidth: CGFloat, safeArea: LayoutInsets, trailingItems: Int) -> CGFloat {
        max(0, barWidth - safeArea.left - safeArea.right - 32 - CGFloat(trailingItems) * 48 - 2 * Metrics.barGlassOutset)
    }

    /// Sizes are single-line measurements; `maxWidth` is the room for the
    /// whole switcher.
    public init(title: CGSize, status: Status? = nil, showing: Showing = .title, chevron: CGSize, maxWidth: CGFloat = .greatestFiniteMagnitude) {
        typealias M = Metrics
        let textX = M.leading + M.picture + M.pictureGap
        let fixed = textX + M.chevronGap + chevron.width + M.trailing
        let room = max(0, maxWidth - fixed)
        let titleWidth = min(title.width, room)
        picture = CGRect(x: M.leading, y: (M.height - M.picture) / 2, width: M.picture, height: M.picture)
        let top = ((M.height - title.height) / 2).rounded()
        self.title = CGRect(x: textX, y: top, width: titleWidth, height: title.height)

        var statusWidth: CGFloat = 0
        if let status {
            let textRoom = max(0, room - status.spinner.width - M.spinnerGap)
            let words = min(status.text.width, textRoom)
            let line = ((M.height - status.text.height) / 2).rounded()
            let mid = line + status.text.height / 2
            spinner = CGRect(x: textX, y: (mid - status.spinner.height / 2).rounded(), width: status.spinner.width, height: status.spinner.height)
            self.status = CGRect(x: spinner.maxX + M.spinnerGap, y: line, width: words, height: status.text.height)
            statusWidth = self.status.maxX - textX
        } else {
            spinner = .zero
            self.status = .zero
        }

        let content = showing == .status && status != nil ? statusWidth : titleWidth
        size = CGSize(width: (fixed + content).rounded(.up), height: M.height)
        self.chevron = CGRect(x: textX + content + M.chevronGap, y: (top + (title.height - chevron.height) / 2).rounded(), width: chevron.width, height: chevron.height)
    }
}
