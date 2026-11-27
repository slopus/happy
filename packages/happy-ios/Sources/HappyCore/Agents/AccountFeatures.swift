import Foundation
import HappyWire

// Feature plugins on a Happy Cloud server (API.md, "Feature plugins"): a
// person installs or uninstalls one of Happy's own features for their whole
// account, in every team they are in, through the plugin routes. Uninstalled
// hides the feature from that person and deletes nothing. The one feature
// today is `pipelines`; every feature is available until its plugin is
// uninstalled.

/// One feature as it is for the account (`GET /v0/features`).
public struct AccountFeature: Equatable, Sendable, Codable {
    public var id: String
    public var available: Bool

    public init(id: String, available: Bool) {
        self.id = id
        self.available = available
    }
}

/// What is available to the account, as `GET /v0/features` last answered or
/// the last `features.updated` said.
public struct AccountFeatures: Equatable, Sendable {
    public static let pipelines = "pipelines"
    /// The event that carries the whole list, private to the person.
    public static let updated = "features.updated"

    /// Nil on a server without feature plugins (no `capabilities.features`,
    /// or `404`, `501`), or before it is read: every feature is available.
    public var list: [AccountFeature]?

    public init(_ list: [AccountFeature]? = nil) {
        self.list = list
    }

    public func feature(_ id: String) -> AccountFeature? { list?.first { $0.id == id } }

    /// Available unless the account uninstalled its plugin.
    public func available(_ id: String) -> Bool { feature(id)?.available ?? true }

    /// `{ features }`, an answer's or an event's payload; one entry this
    /// app can't read drops out. Nil when there is no list at all.
    public static func read(_ value: JSONValue?) -> [AccountFeature]? {
        guard let entries = value?["features"]?.arrayValue else { return nil }
        return entries.compactMap { entry in
            guard let id = entry["id"]?.stringValue, let available = entry["available"]?.boolValue else { return nil }
            return AccountFeature(id: id, available: available)
        }
    }

    /// `feature` made unavailable here, as a refusal says it is, the rest as they were.
    public func unavailable(_ id: String) -> AccountFeatures {
        var list = list ?? []
        if let index = list.firstIndex(where: { $0.id == id }) { list[index].available = false }
        else { list.append(AccountFeature(id: id, available: false)) }
        return AccountFeatures(list)
    }

    /// A route of a feature whose plugin the person uninstalled answers
    /// `403` `feature_not_installed`, before anything else is checked: the
    /// feature is unavailable, not an error to show.
    public static func refused(_ error: any Error) -> Bool {
        if case AgentClientError.status(403, "feature_not_installed"?, _) = error { return true }
        return false
    }
}

/// Hears every route's `403 feature_not_installed` (`AgentClient.send`):
/// the engine takes the feature as unavailable.
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
    /// What is available to the account; nil from a server without feature
    /// plugins (its health says no `features`, or `404`, `501`), where
    /// every feature is available.
    public func accountFeatures() async throws -> [AccountFeature]? {
        guard try await health().capabilities?.features == true else { return nil }
        do { return AccountFeatures.read(try await decode(JSONValue.self, "GET", "/v0/features")) ?? [] }
        catch AgentClientError.status(404, _, _), AgentClientError.status(501, _, _) { return nil }
    }
}
