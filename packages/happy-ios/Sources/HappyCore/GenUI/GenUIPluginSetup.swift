import Foundation
import HappyWire

/// One `plugin` element of an artifact version telling its origin agent
/// that the plugin is set up (the cluster's API.md, "Gen UI actions"):
/// sent once the person has tapped it and the plugin has an active
/// installation. Neither the action nor the plugin is sent; the server
/// reads them from the stored document.
public struct GenUIPluginSetup: Equatable, Sendable {
    public var artifactId: String
    public var version: Int
    /// The element's render key.
    public var element: String
    /// The submission's retry key, the same on every try.
    public var id: String

    public init(artifactId: String, version: Int, element: String, id: String) {
        self.artifactId = artifactId
        self.version = version
        self.element = element
        self.id = id
    }

    /// Whether `pluginId` has an installation that serves.
    public static func isSetUp(_ pluginId: String, in installations: [PluginInstallation]?) -> Bool {
        (installations ?? []).contains { $0.pluginId == pluginId && $0.status == .active }
    }

    public var body: JSONValue { .object(["id": .string(id), "element": .string(element)]) }

    /// What the server answered.
    public enum Outcome: Equatable, Sendable {
        /// Told (`201`), or told before (`200`): the element is done.
        case reported(GenUIPluginReported)
        /// `409 not_set_up`: no active installation yet; nothing changes.
        case notSetUp
        /// Never reached the server, or it failed: tried again with the same `id`.
        case failed
        /// `404`, `409 no_origin` or any other refusal: never tried again.
        case refused
    }

    /// An error as an outcome: whether trying again could help.
    public static func outcome(_ error: Error) -> Outcome {
        guard let error = error as? AgentClientError else { return .failed }
        switch error {
        case .status(409, let code, _) where code == "not_set_up": return .notSetUp
        case .status(let status, _, _) where status >= 500 || status == 408 || status == 429: return .failed
        case .status, .revoked: return .refused
        // A success whose body couldn't be read: it was taken.
        case .invalidResponse: return .reported(GenUIPluginReported())
        }
    }
}

/// The server's answer to a setup report: the installations the agent was
/// told about, and the message that told it.
public struct GenUIPluginReported: Decodable, Equatable, Sendable {
    public struct Installation: Decodable, Equatable, Sendable {
        public var id: String
        public var label: String?
        public var toolPrefix: String?

        public init(id: String, label: String? = nil, toolPrefix: String? = nil) {
            self.id = id
            self.label = label
            self.toolPrefix = toolPrefix
        }
    }

    public var pluginId: String?
    public var installations: [Installation]
    public var messageId: String?

    public init(pluginId: String? = nil, installations: [Installation] = [], messageId: String? = nil) {
        self.pluginId = pluginId
        self.installations = installations
        self.messageId = messageId
    }

    enum CodingKeys: String, CodingKey { case pluginId, installations, messageId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pluginId = try? c.decodeIfPresent(String.self, forKey: .pluginId)
        installations = ((try? c.decodeIfPresent([Lossy<Installation>].self, forKey: .installations)) ?? []).compactMap(\.value)
        messageId = try? c.decodeIfPresent(String.self, forKey: .messageId)
    }
}

extension AgentClient {
    /// Sends one setup report (`POST /v0/artifacts/:id/versions/:n/actions`).
    public func reportPluginSetup(_ setup: GenUIPluginSetup) async throws -> GenUIPluginReported {
        try await decode(GenUIPluginReported.self, "POST", "/v0/artifacts/\(Self.escape(setup.artifactId))/versions/\(setup.version)/actions", json: setup.body)
    }
}

/// Each `plugin` element's report on one client, by version and element:
/// one submission ID kept for every try, one request at a time, and none
/// once it was reported or refused. A failed try is tried again after
/// each of `delays`; past them, the next call tries again, same ID.
public actor GenUIPluginSetupReports {
    private struct Key: Hashable { var artifactId: String; var version: Int; var element: String }

    private let delays: [Duration]
    private var ids: [Key: String] = [:]
    private var settled: [Key: GenUIPluginSetup.Outcome] = [:]
    private var running: [Key: Task<GenUIPluginSetup.Outcome, Never>] = [:]

    public init(delays: [Duration] = [.seconds(1), .seconds(3), .seconds(10)]) {
        self.delays = delays
    }

    /// Reports `element` of `artifactId`'s `version` through `client`,
    /// unless it already was; a call while one runs waits for that one.
    public func report(artifactId: String, version: Int, element: String, via client: AgentClient) async -> GenUIPluginSetup.Outcome {
        let key = Key(artifactId: artifactId, version: version, element: element)
        if let settled = settled[key] { return settled }
        if let running = running[key] { return await running.value }
        let id = ids[key] ?? ClientID.make()
        ids[key] = id
        let setup = GenUIPluginSetup(artifactId: artifactId, version: version, element: element, id: id)
        let delays = delays
        let task = Task { () -> GenUIPluginSetup.Outcome in
            var outcome = GenUIPluginSetup.Outcome.failed
            for attempt in 0...delays.count {
                do { return .reported(try await client.reportPluginSetup(setup)) }
                catch { outcome = GenUIPluginSetup.outcome(error) }
                guard outcome == .failed, attempt < delays.count, !Task.isCancelled else { return outcome }
                try? await Task.sleep(for: delays[attempt])
            }
            return outcome
        }
        running[key] = task
        let outcome = await task.value
        running[key] = nil
        switch outcome {
        case .reported, .refused: settled[key] = outcome
        case .notSetUp, .failed: break
        }
        return outcome
    }

    /// The submission ID `element` was or will be reported under.
    func submission(artifactId: String, version: Int, element: String) -> String? {
        ids[Key(artifactId: artifactId, version: version, element: element)]
    }
}
