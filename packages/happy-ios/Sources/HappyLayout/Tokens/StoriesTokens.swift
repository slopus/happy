import Foundation

// Stories: Telegram's stories row and viewer (`DefaultDayPresentationTheme`,
// `DefaultDarkPresentationTheme` `storyUnseenColors`, `storySeenColors`,
// `itemCheckColors`), on Stem Cells' own ground.

extension Palette {
    /// An unseen ring's gradient, top to bottom.
    public static let storiesUnseenTop = ColorToken("#34C76F")
    public static let storiesUnseenBottom = ColorToken("#3DA1FD")
    /// A seen ring.
    public static let storiesSeen = ColorToken("#D8D8E1", "#48484A")
    /// My Story's "+" and its glyph.
    public static let storiesPlus = ColorToken("#007AFF", "#3E88F7")
    public static let storiesPlusGlyph = ColorToken("#FFFFFF")
    /// An avatar without a photo, under its initials.
    public static let storiesAvatarFill = ColorToken("#B8BBC4", "#5A5A5F")
    public static let storiesAvatarText = ColorToken("#FFFFFF")
    /// The viewer's ground and chrome.
    public static let storiesViewerGround = ColorToken("#000000")
    public static let storiesViewerText = ColorToken("#FFFFFF")
    public static let storiesProgressTrack = ColorToken(light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.3), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.3))
    public static let storiesProgressFill = ColorToken("#FFFFFF")
}
