import Foundation

// Happy Cloud's welcome: Continue with Google in Google's own colours
// (developers.google.com/identity/branding-guidelines), its light theme
// where Apple's button is black and its dark theme where Apple's is white.

extension Palette {
    public static let googleButtonFill = ColorToken("#FFFFFF", "#131314")
    public static let googleButtonStroke = ColorToken("#747775", "#8E918F")
    public static let googleButtonText = ColorToken("#1F1F1F", "#E3E3E3")
    /// The "G"'s four colours, the same on both themes.
    public static let googleBlue = ColorToken("#4285F4")
    public static let googleGreen = ColorToken("#34A853")
    public static let googleYellow = ColorToken("#FBBC05")
    public static let googleRed = ColorToken("#EA4335")

    public static let google: [ColorToken] = [
        googleButtonFill, googleButtonStroke, googleButtonText, googleBlue, googleGreen, googleYellow, googleRed,
    ]
}
