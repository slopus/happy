import Foundation

// The composer's "+" menu: Telegram's attachment menu colours
// (`AttachmentController`'s dim, `AttachmentContainer`'s pill,
// `AttachmentPanel`'s tab bar, `MediaPickerScreen`'s camera cell).

extension Palette {
    /// Over the chat while the menu is up.
    public static let attachMenuDim = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.25), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.25))
    /// The sheet's grabber: the text colour at 7% (20% dark).
    public static let attachMenuGrabber = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.07), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.2))
    /// A tab's ink, and the chosen tab's ink and pill.
    public static let attachMenuTab = ColorToken("#8E8E93", "#98989F")
    public static let attachMenuTabSelected = ColorToken("#007AFF", "#3E88F7")
    public static let attachMenuTabPill = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.06), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.1))
    /// The camera's cell before its preview: black, its glyph white.
    public static let attachMenuCamera = ColorToken("#000000")
    public static let attachMenuCameraGlyph = ColorToken("#FFFFFF")
    /// The no-access picture.
    public static let attachMenuPlaceholderIcon = ColorToken("#C7C7CC", "#545458")
    /// A sending picture: the tile dimmed under Telegram's
    /// `mediaOverlayControlColors` disc, its arc and cross white.
    public static let uploadDim = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.2), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.2))
    public static let uploadDisc = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.45), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.45))
    public static let uploadInk = ColorToken("#FFFFFF")
}
