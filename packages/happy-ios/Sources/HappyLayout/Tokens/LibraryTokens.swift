import Foundation

// The photo library sheet: Telegram's attachment gallery colours
// (`itemCheckColors`, `MediaPickerManageNode`, `MediaPickerGridItem`).

extension Palette {
    /// The sheet's ground, and a cell before its picture arrives.
    public static let libraryGround = ColorToken("#FFFFFF", "#1C1C1E")
    public static let libraryPlaceholder = ColorToken("#EFEFF4", "#2C2C2E")
    /// A picked cell's number circle, and its number.
    public static let libraryCheckFill = ColorToken("#007AFF", "#3E88F7")
    public static let libraryCheckText = ColorToken("#FFFFFF")
    /// The circle's ring over a picture, with its shadow.
    public static let libraryCheckBorder = ColorToken("#FFFFFF")
    public static let libraryCheckShadow = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.22), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.22))
    /// The limited-access note's text and its button.
    public static let libraryNoteText = ColorToken("#6D6D72", "#8D8E93")
    public static let libraryNoteButton = ColorToken("#007AFF", "#3E88F7")
    public static let libraryNoteButtonText = ColorToken("#FFFFFF")
}
