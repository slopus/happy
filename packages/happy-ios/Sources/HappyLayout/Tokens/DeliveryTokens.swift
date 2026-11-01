import Foundation

extension Palette {
    /// The time and the delivery mark in a person's own bubble: the
    /// bubble's secondary ink, as Telegram's outgoing bubble sets both in
    /// one colour.
    public static let deliveryInk = Palette.textSecondary
    /// On pictures sent alone, over Telegram's dark pill.
    public static let deliveryOnMedia = ColorToken("#FFFFFF")
    public static let deliveryPill = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.3), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.3))
    /// A refused send's mark (`deliveryFailedColors`).
    public static let deliveryFailed = ColorToken("#FF3B30")
}

extension ChatTextStyles {
    /// The bubble's time: Telegram's 11 at its 17 base, the system face.
    /// It follows the text size, as Telegram's date follows its base size.
    public static let messageTime = ChatTextStyle(.system(.regular), size: 11)
}
