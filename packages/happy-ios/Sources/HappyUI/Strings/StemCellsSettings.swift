import Foundation
import HappyCore

// Stem Cells settings and the link sheet: the rows a profile's page shows
// beside the ones happy-app names (`Strings.Settings`), and adding a
// computer. English only, as the rest of Stem Cells is.
extension Strings.StemCells {
    public static let editName = "Edit name"
    public static let addComputer = "Add a computer"
    public static let voice = "Voice"
    public static let connectTerminal = "Scan terminal QR code"
    public static let enterTerminalURL = "Enter terminal URL"
    public static let connect = "Connect"
    public static let connected = "Connected"

    // The link sheet: a computer straight to this phone, or by the relay.
    public static let linkTitle = "Link your computer"
    /// The last of its steps, after the relay checklist's two.
    public static let linkScanStep = "Scan the QR code"
    public static let linkScanBody = "This phone connects straight to your computer."
    public static let legacyRelay = "Connect through legacy relay"
    public static let experiments = "Experiments"
    public static let directConnection = "Direct connection"
    public static let directExperimentTitle = "Direct connection is an experiment"
    public static let directExperimentDetail = "Connecting this phone straight to a computer is still experimental. Turn it on to go on; you can turn it off again in Settings, under Experiments."
    public static let turnOn = "Turn on"
    public static let relay = "Relay"
    public static let direct = "Direct"
    public static let beta = "Beta"
}
