import Foundation

/// How a pairing began.
public enum PairingStart: Sendable {
    case scan
    case pasteLink
    /// A link opened from outside the app.
    case openedLink
}
