import Foundation

/// The browser screen. The page runs under the header and down to the
/// screen's bottom edge, under the home indicator: WebKit insets its
/// content by the safe area itself, so the frame never depends on the
/// header and nothing moves when it appears. The loading bar sits on the
/// header's bottom edge, and the error page covers the page whole.
public struct BrowserLayout: Equatable, Sendable {
    public let web: CGRect
    public let progress: CGRect
    public let failure: CGRect

    public init(size: CGSize, top: CGFloat) {
        let bounds = CGRect(origin: .zero, size: CGSize(width: max(0, size.width), height: max(0, size.height)))
        web = bounds
        failure = bounds
        progress = CGRect(x: 0, y: min(max(0, top), bounds.height), width: bounds.width, height: BrowserMetrics.progressHeight)
    }

    /// The filled part of a loading bar of `bar`'s size at `value`, from
    /// the leading edge.
    public static func progressFill(bar: CGSize, value: Double) -> CGRect {
        let value = value.isFinite ? min(max(value, 0), 1) : 0
        return CGRect(x: 0, y: 0, width: max(0, bar.width) * CGFloat(value), height: max(0, bar.height))
    }
}

/// The error page's glyph, title, words and button, one under another,
/// centred across and a little above the middle of the area the header
/// and the home indicator leave. A block taller than that area starts at
/// its top.
public struct BrowserFailureLayout: Equatable, Sendable {
    public let icon: CGRect
    public let title: CGRect
    public let message: CGRect
    public let button: CGRect

    /// The width the title and message are measured at.
    public static func textWidth(size: CGSize, insets: LayoutInsets) -> CGFloat {
        let free = size.width - insets.left - insets.right - BrowserMetrics.failureMargin * 2
        return max(0, min(BrowserMetrics.failureTextWidth, free))
    }

    public init(size: CGSize, insets: LayoutInsets, title: Measurable, message: Measurable, button: CGSize) {
        let width = Self.textWidth(size: size, insets: insets)
        let titleSize = title.size(fitting: width)
        let messageSize = message.size(fitting: width)
        let iconSide = BrowserMetrics.failureIcon
        let height = iconSide + BrowserMetrics.failureIconToTitle + titleSize.height
            + (messageSize.height > 0 ? BrowserMetrics.failureTitleToMessage + messageSize.height : 0)
            + BrowserMetrics.failureMessageToButton + button.height
        let freeTop = insets.top
        let freeHeight = max(0, size.height - insets.top - insets.bottom)
        let centred = freeTop + (freeHeight - height) / 2 - BrowserMetrics.failureLift
        let top = max(freeTop, centred)
        let midX = insets.left + (size.width - insets.left - insets.right) / 2

        icon = CGRect(x: midX - iconSide / 2, y: top, width: iconSide, height: iconSide)
        self.title = CGRect(x: midX - width / 2, y: icon.maxY + BrowserMetrics.failureIconToTitle, width: width, height: titleSize.height)
        let messageTop = self.title.maxY + (messageSize.height > 0 ? BrowserMetrics.failureTitleToMessage : 0)
        self.message = CGRect(x: midX - width / 2, y: messageTop, width: width, height: messageSize.height)
        let buttonWidth = min(button.width, width)
        self.button = CGRect(x: midX - buttonWidth / 2, y: self.message.maxY + BrowserMetrics.failureMessageToButton, width: buttonWidth, height: button.height)
    }
}
