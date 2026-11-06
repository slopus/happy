import Foundation
import HappyWire

/// Happy Cloud: a team server like any other, at the one address compiled
/// into the app. It is the only server added without a scanned code, since
/// the address is the app's own and not one typed, pasted or opened from a
/// link. Its installation is recorded from health after sign-in but checked
/// against nothing (docs/SERVER-SIGN-IN.md, "Happy Cloud").
public enum HappyCloud {
    /// The cloud's API origin. Change it here only.
    public static let server = "https://209-38-182-152.sslip.io"
    public static let name = "Happy Cloud"

    /// The connection already signed in to the cloud, if there is one.
    public static func connection(in connections: [AgentConnection]) -> AgentConnection? {
        connections.first { $0.server == server }
    }

    public static func isCloud(_ server: String?) -> Bool { server == Self.server }
}
