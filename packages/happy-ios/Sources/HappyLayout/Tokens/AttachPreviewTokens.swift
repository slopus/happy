import Foundation

// The "+" menu's picture opened whole: Telegram's media picker gallery is
// black in either theme, its buttons white (`viewerGround`, `viewerControl`).

extension Palette {
    /// A video's play button behind its glyph (`TGMessageImageViewOverlayView`, play).
    public static let attachPreviewPlay = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.3), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.3))
    /// The back chevron's shadow, as the check's ring has.
    public static let attachPreviewShadow = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.22), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.22))
    /// Over the pictures while the caption is typed (`TGPhotoCaptionInputMixin`'s dismiss view).
    public static let attachPreviewTypingDim = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.4), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.4))
}
