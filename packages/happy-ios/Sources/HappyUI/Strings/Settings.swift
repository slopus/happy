import Foundation
import HappyCore

// V2 settings and the link sheet: the rows a profile's page shows
// beside the ones happy-app names (`Strings.Settings`), and adding a
// computer. English only, as the rest of V2 is.
extension Strings {
    public static let voice = "Voice"
    public static let connectTerminal = "Scan terminal QR code"
    public static let enterTerminalURL = "Enter terminal URL"
    public static let connect = "Connect"
    public static let connected = "Connected"

    // The link sheet: a computer straight to this phone, or by the relay.
    public static let linkTitle = "Connect Agent"
    /// The last of its steps, after the relay checklist's two.
    public static let linkScanStep = "Scan the QR code"
    public static let linkScanBody = "This phone connects straight to the agent."
    public static let legacyRelay = "Connect through legacy relay"
    public static let experiments = "Experiments"
    public static let turnOn = "Turn on"
    public static let relay = "Relay"
    public static let direct = "Direct"
    public static let beta = "Beta"
}
