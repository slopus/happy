import Foundation

/// How a pairing began.
public enum PairingStart: String, Sendable {
    case scan
    case pasteLink = "paste_link"
    /// A link opened from outside the app.
    case openedLink = "opened_link"
}
