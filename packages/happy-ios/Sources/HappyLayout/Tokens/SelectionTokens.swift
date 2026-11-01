import Foundation

extension Palette {
    /// A text selection, as Telegram themes an incoming message's
    /// (`textSelectionColor`, the accent at 0.2; `textSelectionKnobColor`,
    /// the accent): over the system blue, day and night.
    public static let selectionHighlight = ColorToken(light: RGBA(red: 0, green: 0.478, blue: 1, alpha: 0.2), dark: RGBA(red: 0.039, green: 0.518, blue: 1, alpha: 0.3))
    public static let selectionKnob = ColorToken("#007aff", "#0a84ff")
    /// The card an agent's words, which have no bubble, lift on.
    public static let liftCard = ColorToken("#ffffff", "#1c1c1e")
}
