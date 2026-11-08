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
        /// A cancel's bin, as Telegram tints its `BinRed` (`0xFF3B30`).
        public static let bin = ColorToken("#FF3B30", "#FF453A")
        /// The glyph on the circle.
        public static let glyph = ColorToken("#FFFFFF")
        /// The lock and its chevron (`panelControlColor`).
        public static let lock = ColorToken("#8E8E93", "#8E8E93")
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
