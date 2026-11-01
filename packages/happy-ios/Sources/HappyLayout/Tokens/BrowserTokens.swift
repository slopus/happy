import Foundation

// The in-app browser: Safari's thin loading bar under the header, and the
// full-screen page that says why a page didn't open (Safari's and
// Telegram's: a glyph, a title, a sentence or two and one button).

public enum BrowserMetrics {
    /// The loading bar's thickness.
    public static let progressHeight: CGFloat = 2.5
    /// The error page's glyph.
    public static let failureIcon: CGFloat = 52
    /// The widest the error page's words run, on an iPad or in landscape.
    public static let failureTextWidth: CGFloat = 320
    /// The least space between the words and the screen's sides.
    public static let failureMargin: CGFloat = 32
    public static let failureIconToTitle: CGFloat = 16
    public static let failureTitleToMessage: CGFloat = 8
    public static let failureMessageToButton: CGFloat = 24
    /// How far above the middle of the free area the block sits, as
    /// Safari's does: centred exactly, it reads as low.
    public static let failureLift: CGFloat = 24
}

extension Palette {
    /// The loading bar, Safari's blue.
    public static let browserProgress = ColorToken("#007AFF", "#0A84FF")
    /// The error page's glyph.
    public static let browserFailureIcon = ColorToken("#8E8E93", "#8E8E93")
}

extension TextStyles {
    /// The error page's title: "Can’t Reach Studio Mac".
    public static let browserFailureTitle = TextStyle(.semiBold, size: 20, lineHeight: 25)
    /// The sentence under it.
    public static let browserFailureMessage = TextStyle(.regular, size: 15, lineHeight: 20)
}
