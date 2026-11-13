import Foundation

// The composer's "+" menu in Telegram's own colours: its default day theme
// (`makeDefaultDayPresentationTheme`, accent #0088FF) and its night theme
// (`defaultDarkColorPresentationTheme`, accent #3E88F7), as the attachment
// menu reads them (`AttachmentController`'s dim, `AttachmentPanel`'s tab
// bar from `rootController.tabBar`, `MediaPickerScreen`'s grid from
// `list`, `CheckNode`'s overlay style from `list.itemCheckColors`,
// `MediaPickerTitleView` from `rootController.navigationBar`), but with
// the chat composer's send in place of Telegram's blue accent.

extension Palette {
    /// Over the chat while the menu is up.
    public static let attachMenuDim = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.25), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.25))
    /// The sheet under the grid: `list.plainBackgroundColor`.
    public static let attachMenuGround = ColorToken("#FFFFFF", "#000000")
    /// A cell before its picture: `list.mediaPlaceholderColor` (night:
    /// white mixed 90% into #1C1C1D).
    public static let attachMenuCellPlaceholder = ColorToken("#EFEFF4", "#333334")
    /// The accent: a picked circle's fill, a button's fill. The chat
    /// composer's send (AgentInputPrimaryButton, `.send`).
    public static let attachMenuAccent = surfaceHighest
    /// On the accent: the number, a button's title; send's arrow.
    public static let attachMenuOnAccent = text
    /// The circle over a picture (`CheckNode`, overlay): a white ring with
    /// a black shadow at 22%.
    public static let attachMenuCheckRing = ColorToken("#FFFFFF")
    public static let attachMenuCheckShadow = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.22), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.22))
    /// A tab's glyph and name (`tabBar.textColor`): black at 80% by day,
    /// white at night; the chosen one is full black or white, the lens
    /// behind it marking it.
    public static let attachMenuTab = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.8), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 1))
    public static let attachMenuTabSelected = text
    /// The lens behind the chosen tab (`LiquidLensView`'s selection).
    public static let attachMenuLens = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.075), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.1))
    /// The header's title (`navigationBar.primaryTextColor`); its album
    /// arrow is the same at 40%. Over a scrolled grid both turn white.
    public static let attachMenuTitle = ColorToken("#000000", "#FFFFFF")
    /// The fade at the top of a scrolled grid, under the glass buttons.
    public static let attachMenuTopEdge = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.45), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.45))
    /// A glyph on glass (`inputPanel.panelControlColor`): close, and ✓N
    /// and its count beside it.
    public static let attachMenuControl = ColorToken("#000000", "#FFFFFF")
    /// The caption's text and placeholder (`inputPanel`).
    public static let attachMenuCaption = ColorToken("#000000", "#FFFFFF")
    public static let attachMenuCaptionPlaceholder = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.4), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.48))
    /// A note under the header (`list.freeTextColor`).
    public static let attachMenuNote = ColorToken("#6D6D72", "#8D8E93")
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
