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
}
