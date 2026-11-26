import Foundation
import HappyWire

// Account features on a Happy Cloud server (API.md, "Account features"):
// what a person turned off for their whole account, in every team they are
// in. Off hides a feature from that person and deletes nothing. The one
// feature today is `pipelines`; every feature is on until turned off.

/// One feature as it is for the account (`Feature`).
public struct AccountFeature: Equatable, Sendable, Codable {
    public var id: String
    public var name: String
    public var enabled: Bool

    public init(id: String, name: String, enabled: Bool) {
        self.id = id
        self.name = name
        self.enabled = enabled
    }
}

/// The account's features, as `GET /v0/account/features` last answered or
/// the last `account.features.updated` said.
public struct AccountFeatures: Equatable, Sendable {
    public static let pipelines = "pipelines"
    /// The event that carries the whole list, private to the person.
    public static let updated = "account.features.updated"

    /// Nil on a server without the list (`404`, `501`), or before it is
    /// read: every feature is on.
    public var list: [AccountFeature]?

    public init(_ list: [AccountFeature]? = nil) {
        self.list = list
    }

    public func feature(_ id: String) -> AccountFeature? { list?.first { $0.id == id } }

    /// On unless the account turned it off.
    public func enabled(_ id: String) -> Bool { feature(id)?.enabled ?? true }

    /// `{ features }`, an answer's or an event's payload; one entry this
    /// app can't read drops out. Nil when there is no list at all.
    public static func read(_ value: JSONValue?) -> [AccountFeature]? {
        guard let entries = value?["features"]?.arrayValue else { return nil }
        return entries.compactMap { entry in
            guard let id = entry["id"]?.stringValue, let enabled = entry["enabled"]?.boolValue else { return nil }
            return AccountFeature(id: id, name: entry["name"]?.stringValue ?? id, enabled: enabled)
        }
    }

    /// `feature` turned off here, as a refusal says it is, the rest as they were.
    public func turningOff(_ id: String) -> AccountFeatures {
        var list = list ?? []
        if let index = list.firstIndex(where: { $0.id == id }) { list[index].enabled = false }
        else { list.append(AccountFeature(id: id, name: id, enabled: false)) }
        return AccountFeatures(list)
    }

    /// A route of a feature the person turned off answers `403`
    /// `feature_not_installed`, before anything else is checked: the
    /// feature is off, not an error to show.
    public static func refused(_ error: any Error) -> Bool {
        if case AgentClientError.status(403, "feature_not_installed"?, _) = error { return true }
        return false
    }
}

/// Hears every route's `403 feature_not_installed` (`AgentClient.send`):
/// the engine takes the feature as off.
public final class FeatureRefusals: @unchecked Sendable {
    private let lock = NSLock()
    private var listener: (@Sendable (String) -> Void)?

    public init() {}

    func listen(_ listener: @escaping @Sendable (String) -> Void) { lock.withLock { self.listener = listener } }

    func heard(_ response: HTTP1Response) {
        guard response.status == 403, let refusal = try? JSONValue.decode(response.body),
              refusal["code"]?.stringValue == "feature_not_installed", let feature = refusal["feature"]?.stringValue else { return }
        let listener = lock.withLock { self.listener }
        listener?(feature)
    }
}

extension AgentClient {
    /// The account's features; nil from a server without them (`404`,
    /// `501`), where every feature is on.
    public func accountFeatures() async throws -> [AccountFeature]? {
        do { return AccountFeatures.read(try await decode(JSONValue.self, "GET", "/v0/account/features")) ?? [] }
        catch AgentClientError.status(404, _, _), AgentClientError.status(501, _, _) { return nil }
    }
}
