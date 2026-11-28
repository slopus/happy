import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Settings › Inference: a computer's Codex, Claude and Grok accounts, and
// an account's Sign in again page.

extension Palette {
    /// An account row's status dot: working, renewing fails, needs sign-in,
    /// off or not known.
    public static let inferenceDotWorking = statusConnected
    public static let inferenceDotRefreshFailed = ColorToken("#ff9500", "#ffab00")
    public static let inferenceDotNeedsSignIn = statusError
    public static let inferenceDotOff = statusDisconnected
}

extension TextStyles {
    /// Sign in again: the account's name over the card's heading.
    public static let inferenceSignInName = TextStyle(.regular, size: 15, lineHeight: 20, letterSpacing: -0.24)
    public static let inferenceSignInHeading = TextStyle(.semiBold, size: 20, lineHeight: 25)
    /// The device code to type at the vendor.
    public static let inferenceSignInCode = TextStyle(.monoSemiBold, size: 32, lineHeight: 40)
    /// The computer's words, and the pasted code as it is typed.
    public static let inferenceSignInMessage = TextStyle(.regular, size: 15, lineHeight: 20, letterSpacing: -0.24)
    public static let inferenceSignInStatus = TextStyle(.regular, size: 13, lineHeight: 18, letterSpacing: -0.08)
}
