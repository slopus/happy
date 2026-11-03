import Foundation

// The voice call's bar (CallBarView). Its colours are Happy's first-run
// palette, Grain Gradient's saturated set (StartViewController.Colors.grain,
// Android's ui/start/StartScreen.kt), the same in light and dark, as
// Telegram's bar is. White words keep AA (4.5:1) or better on every one.

/// The two ends of the bar's gradient for each state of the call.
public struct CallBarGradient: Equatable, Sendable {
    public var start: RGBA
    public var end: RGBA

    init(_ start: String, _ end: String) {
        self.start = RGBA(hex: start) ?? .invalid
        self.end = RGBA(hex: end) ?? .invalid
    }
}

extension Palette {
    public enum CallBar {
        /// Connecting, or ending: iOS's high-contrast system grey, so it
        /// reads as not live yet (Telegram's is grey too).
        public static let connecting = CallBarGradient("#6C6C70", "#6C6C70")
        /// Live and quiet: indigo into violet.
        public static let listening = CallBarGradient("#4338CA", "#7C3AED")
        /// Someone is speaking: royal blue into Grain's electric blue.
        public static let speaking = CallBarGradient("#1D4ED8", "#2A00FF")
        /// The microphone is off: violet into indigo, so it reads apart
        /// from listening without leaving the palette.
        public static let muted = CallBarGradient("#7C3AED", "#4338CA")
        /// It couldn't start, or it failed: iOS's high-contrast system red.
        public static let failed = CallBarGradient("#D70015", "#D70015")
        /// The words and glyphs on it.
        public static let text = RGBA(hex: "#FFFFFF") ?? .invalid
    }
}
