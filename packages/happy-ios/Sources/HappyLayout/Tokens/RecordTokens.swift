import Foundation

// The microphone's recording screen (RecordOverlay), in Telegram's colours:
// the system blue circle, its pale ring, the pink-red dot.

extension Palette {
    public enum Record {
        /// The circle under the finger and the locked send.
        public static let circle = ColorToken("#007AFF", "#0A84FF")
        /// The ring the voice swells: the circle at a fifth.
        public static let ringAlpha: CGFloat = 0.2
        /// Telegram's recording dot (`0xFF2D55`).
        public static let dot = ColorToken("#FF2D55", "#FF375F")
        /// The glyph on the circle.
        public static let glyph = ColorToken("#FFFFFF")
        /// The lock and its chevron (`panelControlColor`).
        public static let lock = ColorToken("#8E8E93", "#8E8E93")
        /// The bar's fill over the glass, so what is under it doesn't show
        /// through the clock.
        public static let barFill = ColorToken("#FFFFFFE6", "#1E1E1EE6")
    }
}

extension TextStyles {
    /// "Slide to cancel" (Telegram's 14).
    public static let recordCancel = TextStyle(.regular, size: 14)
    /// "Cancel" once locked (Telegram's 17).
    public static let recordCancelButton = TextStyle(.regular, size: 17)
    /// The hint over the button.
    public static let recordHint = TextStyle(.regular, size: 14)
}
