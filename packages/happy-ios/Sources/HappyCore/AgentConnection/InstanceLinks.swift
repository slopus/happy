import Foundation
import HappyWire

/// Where a Happy link that came from outside the app (another app, a
/// browser, the system) opens, per the edge SSO contract: only on the
/// connection whose installation it names (`happy://<instanceId>/…`),
/// never on another one. A link naming no installation isn't opened at all.
public enum InstanceLinkRoute: Equatable, Sendable {
    /// Not a Happy entity or file link: someone else's to read.
    case notALink
    /// A Happy link that opens nothing from outside: one naming no
    /// installation, or a malformed one.
    case notOpened
    /// An installation this phone isn't connected to.
    case unknownInstance
    /// That connection, and what to show there.
    case open(connection: String, link: HappyLink)

    /// `connections` with the instance IDs they last reported; `active`
    /// wins when more than one is the same installation.
    public static func route(_ text: String, connections: [AgentConnection], active: String?) -> InstanceLinkRoute {
        guard let link = HappyLink(text) else {
            // The app's own `happy://` routes (pairing, OAuth) aren't these.
            guard let host = URLComponents(string: text)?.host, HappyLink.isInstanceID(host) || text.lowercased().hasPrefix("happy-file:") else { return .notALink }
            return .notOpened
        }
        guard let instance = link.instanceId else { return .notOpened }
        let matches = connections.filter { $0.instanceId == instance }
        guard let chosen = matches.first(where: { $0.id == active }) ?? matches.first(where: { !$0.revoked }) ?? matches.first else { return .unknownInstance }
        return .open(connection: chosen.id, link: link)
    }
}
