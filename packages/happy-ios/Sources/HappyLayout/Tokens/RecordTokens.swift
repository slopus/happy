import Foundation

// The microphone's recording screen (RecordOverlay), in Telegram's colours:
// the system blue circle, its pale waves, the pink-red dot.

extension Palette {
    public enum Record {
        /// The circle under the finger and the locked send.
        public static let circle = ColorToken("#007AFF", "#0A84FF")
        /// The waves the voice swells (`RecordBlob`): the circle faint,
        /// the outer fainter, as Telegram's two glass layers read.
        public static let outerWaveAlpha: CGFloat = 0.15
        public static let middleWaveAlpha: CGFloat = 0.25
        /// Telegram's recording dot (`0xFF2D55`).
        public static let dot = ColorToken("#FF2D55", "#FF375F")
        /// The glyph on the circle.
        public static let glyph = ColorToken("#FFFFFF")
        /// The lock and its chevron (`panelControlColor`).
        public static let lock = ColorToken("#8E8E93", "#8E8E93")
        /// The bar's fill over the glass: solid, so the controls it covers
        /// (the field, the toolbar's buttons) don't show through.
        public static let barFill = ColorToken("#FFFFFF", "#1E1E1E")
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
