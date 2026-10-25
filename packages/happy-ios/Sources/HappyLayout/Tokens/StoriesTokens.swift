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
    /// An avatar without a photo, under its initials.
    public static let storiesAvatarFill = ColorToken("#B8BBC4", "#5A5A5F")
    public static let storiesAvatarText = ColorToken("#FFFFFF")
    /// The one-time tooltip under the closed avatars (`TooltipScreen`'s
    /// default style): black at 0.6 over the blur by day, the dark
    /// navigation bar's #1D1D1D at 0.9 by night, white text on both.
    public static let storiesTooltipGround = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.6), dark: RGBA(red: 29 / 255.0, green: 29 / 255.0, blue: 29 / 255.0, alpha: 0.9))
    public static let storiesTooltipText = ColorToken("#FFFFFF")
    /// The viewer's ground and chrome.
    public static let storiesViewerGround = ColorToken("#000000")
    public static let storiesViewerText = ColorToken("#FFFFFF")
    public static let storiesProgressTrack = ColorToken(light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.3), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.3))
    public static let storiesProgressFill = ColorToken("#FFFFFF")
    /// The editor (`MediaEditorScreen`, `DrawingEntitiesView`): Post's
    /// tinted glass, the snap lines, the angle line, a selection's handles.
    public static let storiesEditorPost = ColorToken("#0088FF")
    public static let storiesEditorGuide = ColorToken("#5FC1F0")
    public static let storiesEditorAngle = ColorToken("#FFD70A")
    public static let storiesEditorHandle = ColorToken("#0A60FF")
    /// The sticker sheet's ground and its interactive stickers' pills.
    public static let storiesStickerSheet = ColorToken("#1C1C1E")
    public static let storiesStickerPill = ColorToken(light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.11), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.11))
    /// The views sheet, as the dark theme draws it: its ground (the
    /// navigation bar's #1D1D1D at 0.9 over the black Telegram keeps under
    /// the list, so the story never shows through), the time under a name,
    /// and the lines under the header and between rows.
    public static let storiesViewersGround = ColorToken("#1A1A1A")
    public static let storiesViewersSecondary = ColorToken("#98989E")
    public static let storiesViewersSeparator = ColorToken(light: RGBA(red: 84 / 255.0, green: 84 / 255.0, blue: 88 / 255.0, alpha: 0.55), dark: RGBA(red: 84 / 255.0, green: 84 / 255.0, blue: 88 / 255.0, alpha: 0.55))
}
