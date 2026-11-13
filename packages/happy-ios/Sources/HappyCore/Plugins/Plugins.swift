import Foundation
import HappyWire

/// A plugin a Happy Cloud server offers (`GET /v0/plugins`), installed or
/// not: compiled into the server, it gives agents tools. Its auth lists
/// only the ways in that work on this server.
public struct Plugin: Decodable, Equatable, Sendable, Identifiable {
    public struct Tool: Decodable, Equatable, Sendable {
        public var name: String
        public var summary: String
        public init(name: String, summary: String = "") { self.name = name; self.summary = summary }

        enum CodingKeys: String, CodingKey { case name, summary }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = try c.decode(String.self, forKey: .name)
            summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? ""
        }
    }

    public var id: String
    public var name: String
    public var description: String
    public var version: String
    public var image: PluginImage?
    public var tools: [Tool]
    /// Whether an installation does nothing until it signs in.
    public var authRequired: Bool
    public var authMethods: [PluginAuthMethod]

    public init(id: String, name: String, description: String = "", version: String = "", image: PluginImage? = nil,
                tools: [Tool] = [], authRequired: Bool = false, authMethods: [PluginAuthMethod] = []) {
        self.id = id; self.name = name; self.description = description; self.version = version; self.image = image
        self.tools = tools; self.authRequired = authRequired; self.authMethods = authMethods
    }

    enum CodingKeys: String, CodingKey { case id, name, description, version, image, tools, auth }
    struct Auth: Decodable { var required: Bool?; var methods: [Lossy<PluginAuthMethod>]? }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)).flatMap { $0.isEmpty ? nil : $0 } ?? id
        description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? ""
        version = (try? c.decodeIfPresent(String.self, forKey: .version)) ?? ""
        image = try? c.decodeIfPresent(PluginImage.self, forKey: .image)
        tools = ((try? c.decodeIfPresent([Lossy<Tool>].self, forKey: .tools)) ?? []).compactMap(\.value)
        let auth = try? c.decodeIfPresent(Auth.self, forKey: .auth)
        authRequired = auth?.required ?? false
        authMethods = (auth?.methods ?? []).compactMap(\.value)
    }
}

/// A plugin's picture: its bytes at `path` on the server, its ThumbHash
/// painted until they come.
public struct PluginImage: Decodable, Equatable, Sendable {
    public var digest: String
    public var thumbhash: String?
    public init(digest: String, thumbhash: String? = nil) { self.digest = digest; self.thumbhash = thumbhash }

    public var path: String { "/v0/plugins/images/\(AgentClient.escape(digest))" }
}

/// One way an installation signs in to the service its plugin wraps: the
/// provider's page (`oauth`), or values typed here (`fields`).
public enum PluginAuthMethod: Decodable, Equatable, Sendable {
    public struct Field: Decodable, Equatable, Sendable {
        public var key: String
        public var label: String
        public var help: String
        public var required: Bool
        /// Typed into a secure field, sent once and never shown again.
        public var secret: Bool
        public var multiline: Bool

        public init(key: String, label: String? = nil, help: String = "", required: Bool = false, secret: Bool = false, multiline: Bool = false) {
            self.key = key; self.label = label ?? key; self.help = help; self.required = required; self.secret = secret; self.multiline = multiline
        }

        enum CodingKeys: String, CodingKey { case key, label, help, required, secret, multiline }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            key = try c.decode(String.self, forKey: .key)
            label = (try? c.decodeIfPresent(String.self, forKey: .label)).flatMap { $0.isEmpty ? nil : $0 } ?? key
            help = (try? c.decodeIfPresent(String.self, forKey: .help)) ?? ""
            required = (try? c.decodeIfPresent(Bool.self, forKey: .required)) ?? false
            secret = (try? c.decodeIfPresent(Bool.self, forKey: .secret)) ?? false
            multiline = (try? c.decodeIfPresent(Bool.self, forKey: .multiline)) ?? false
        }
    }

    case oauth(id: String, label: String, scopes: [String])
    case fields(id: String, label: String, fields: [Field])

    public var id: String {
        switch self { case .oauth(let id, _, _), .fields(let id, _, _): id }
    }

    public var label: String {
        switch self { case .oauth(_, let label, _), .fields(_, let label, _): label }
    }

    enum CodingKeys: String, CodingKey { case type, id, label, scopes, fields }
    struct Unknown: Error {}

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id)
        let label = (try? c.decodeIfPresent(String.self, forKey: .label)).flatMap { $0.isEmpty ? nil : $0 } ?? id
        switch try c.decode(String.self, forKey: .type) {
        case "oauth": self = .oauth(id: id, label: label, scopes: (try? c.decodeIfPresent([String].self, forKey: .scopes)) ?? [])
        case "fields": self = .fields(id: id, label: label, fields: ((try? c.decodeIfPresent([Lossy<Field>].self, forKey: .fields)) ?? []).compactMap(\.value))
        default: throw Unknown()
        }
    }
}

/// One installation of a plugin on the team; a plugin may be installed
/// more than once, each counted from 1 (`ordinal`), never reused.
public struct PluginInstallation: Decodable, Equatable, Sendable, Identifiable {
    /// `notConfigured`: installed, waiting for a sign-in.
    /// `methodUnavailable`: signed in a way this server no longer offers.
    public enum Status: Equatable, Sendable { case active, notConfigured, methodUnavailable }

    public var id: String
    public var pluginId: String
    /// Nil once the server stops offering the plugin.
    public var pluginName: String?
    public var ordinal: Int
    public var label: String?
    public var status: Status
    public var authMethod: String?
    /// What the agent's tools from it are called with.
    public var toolPrefix: String
    public var image: PluginImage?
    /// False for a plugin this server no longer offers: it can't be changed or removed then.
    public var available: Bool

    public init(id: String, pluginId: String, pluginName: String? = nil, ordinal: Int = 1, label: String? = nil, status: Status = .active,
                authMethod: String? = nil, toolPrefix: String = "", image: PluginImage? = nil, available: Bool = true) {
        self.id = id; self.pluginId = pluginId; self.pluginName = pluginName; self.ordinal = ordinal; self.label = label; self.status = status
        self.authMethod = authMethod; self.toolPrefix = toolPrefix; self.image = image; self.available = available
    }

    enum CodingKeys: String, CodingKey { case id, plugin, pluginName, ordinal, label, status, reason, authMethod, toolPrefix, image, available }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        pluginId = try c.decode(String.self, forKey: .plugin)
        pluginName = (try? c.decodeIfPresent(String.self, forKey: .pluginName)).flatMap { $0.isEmpty ? nil : $0 }
        ordinal = (try? c.decodeIfPresent(Int.self, forKey: .ordinal)) ?? 1
        label = (try? c.decodeIfPresent(String.self, forKey: .label)).flatMap { $0.isEmpty ? nil : $0 }
        let status = try? c.decodeIfPresent(String.self, forKey: .status)
        let reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        self.status = status == "active" ? .active : reason == "method_unavailable" ? .methodUnavailable : .notConfigured
        authMethod = (try? c.decodeIfPresent(String.self, forKey: .authMethod)).flatMap { $0.isEmpty ? nil : $0 }
        toolPrefix = (try? c.decodeIfPresent(String.self, forKey: .toolPrefix)) ?? ""
        image = try? c.decodeIfPresent(PluginImage.self, forKey: .image)
        available = (try? c.decodeIfPresent(Bool.self, forKey: .available)) ?? true
    }

    /// Signed in with a method, and serving: it has a way out (Sign Out).
    public var isSignedIn: Bool { status == .active && authMethod != nil }

    /// How it is told apart from its siblings: its label, or its number past the first.
    public var title: String {
        let name = pluginName ?? pluginId
        if let label { return "\(name) · \(label)" }
        return ordinal > 1 ? "\(name) \(ordinal)" : name
    }
}

/// The plugins one server offers and the team's installations of them, as
/// the Plugins page shows them.
public struct PluginCatalog: Equatable, Sendable {
    /// Sorted by name.
    public var plugins: [Plugin]
    /// By plugin and ordinal, as the server lists them; nil while the
    /// person may not read them.
    public var installations: [PluginInstallation]?
    /// Whether the person may install, set up and remove plugins.
    public var canManage: Bool

    public init(plugins: [Plugin], installations: [PluginInstallation]?, canManage: Bool) {
        self.plugins = plugins.sorted { ($0.name.lowercased(), $0.id) < ($1.name.lowercased(), $1.id) }
        self.installations = installations
        self.canManage = canManage
    }

    public func plugin(_ id: String) -> Plugin? { plugins.first { $0.id == id } }

    public func installations(of pluginId: String) -> [PluginInstallation] {
        (installations ?? []).filter { $0.pluginId == pluginId }
    }

    /// One plugin's name and picture, from the catalog or, once the server
    /// stops offering it, its installations.
    public func name(of pluginId: String) -> String {
        plugin(pluginId)?.name ?? installations(of: pluginId).first?.pluginName ?? pluginId
    }

    /// What one installation still needs before its tools work, given the
    /// ways its plugin offers: nothing, a sign-in, or nothing it can do here.
    public enum Setup: Equatable, Sendable {
        case ready
        case signIn([PluginAuthMethod])
        /// Its plugin is gone from the server, or offers no way in.
        case unavailable
    }

    public func setup(_ installation: PluginInstallation) -> Setup {
        guard installation.available, let plugin = plugin(installation.pluginId) else { return .unavailable }
        if installation.status == .active { return .ready }
        return plugin.authMethods.isEmpty ? .unavailable : .signIn(plugin.authMethods)
    }

    /// The events after which it is read again: every installation write
    /// journals `plugins.changed`; a role change can change `canManage`.
    public static let refreshEvents = ["plugins.changed"] + Permissions.refreshEvents
}

/// A setup the server refused (`422 invalid_fields`): what is wrong with
/// each field, by key. The messages never repeat a value.
public struct PluginFieldsRefusal: Error, Equatable, Sendable {
    public var message: String?
    public var fields: [String: String]
    public init(message: String?, fields: [String: String]) { self.message = message; self.fields = fields }
}

extension AgentClient {
    /// The catalog and, where the person may read them, the installations.
    /// A server that refuses the installations (`403`, before they were
    /// open to every member) leaves them nil and the person unable to manage.
    public func pluginCatalog() async throws -> PluginCatalog {
        struct Catalog: Decodable { var plugins: [Lossy<Plugin>] }
        struct Installed: Decodable { var installations: [Lossy<PluginInstallation>]; var canManage: Bool? }
        async let catalog = decode(Catalog.self, "GET", "/v0/plugins")
        let installed: Installed?
        do { installed = try await decode(Installed.self, "GET", "/v0/plugins/installations") }
        catch AgentClientError.status(403, _, _) { installed = nil }
        return PluginCatalog(plugins: try await catalog.plugins.compactMap(\.value),
                             installations: installed?.installations.compactMap(\.value),
                             canManage: installed.map { $0.canManage ?? true } ?? false)
    }

    /// Installs `pluginId` once more and answers the new installation.
    public func installPlugin(_ pluginId: String, label: String? = nil) async throws -> PluginInstallation {
        struct Response: Decodable { var installation: PluginInstallation }
        var body: [String: JSONValue] = ["plugin": .string(pluginId)]
        if let label { body["label"] = .string(label) }
        return try await decode(Response.self, "POST", "/v0/plugins/installations", json: .object(body)).installation
    }

    /// Removes an installation with its secrets; one already gone counts as removed.
    public func removePluginInstallation(_ id: String) async throws {
        do { _ = try await send("DELETE", Self.installation(id)) }
        catch AgentClientError.status(404, _, _) {}
    }

    /// Signs an installation in with a fields method. Refused fields throw
    /// `PluginFieldsRefusal`.
    public func configurePluginInstallation(_ id: String, method: String, values: [String: String]) async throws -> PluginInstallation {
        struct Response: Decodable { var installation: PluginInstallation }
        let body = try JSONEncoder().encode(JSONValue.object(["method": .string(method), "values": .object(values.mapValues(JSONValue.string))]))
        let response = try await transport.request(method: "POST", path: Self.installation(id) + "/configure", credential: token, body: body, headers: [:], category: .query)
        if response.status == 401 { throw AgentClientError.revoked }
        if response.status == 422, let refusal = try? JSONValue.decode(response.body), refusal["code"]?.stringValue == "invalid_fields",
           let fields = refusal["fields"]?.objectValue {
            throw PluginFieldsRefusal(message: refusal["error"]?.stringValue ?? refusal["message"]?.stringValue, fields: fields.compactMapValues(\.stringValue))
        }
        let checked = try Self.checked(response)
        do { return try JSONDecoder().decode(Response.self, from: checked.body).installation }
        catch { throw AgentClientError.invalidResponse }
    }

    /// Starts an OAuth sign-in: the provider's page to send the person to.
    /// Only an https page is taken.
    public func connectPluginInstallation(_ id: String, method: String) async throws -> URL {
        struct Response: Decodable { var authorizeUrl: String }
        let answer = try await decode(Response.self, "POST", Self.installation(id) + "/connect", json: .object(["method": .string(method)]))
        guard let url = URL(string: answer.authorizeUrl), url.scheme?.lowercased() == "https", url.host?.isEmpty == false else {
            throw AgentClientError.invalidResponse
        }
        return url
    }

    /// Forgets every secret of an installation, revoked upstream where it can be.
    public func disconnectPluginInstallation(_ id: String) async throws {
        _ = try await send("POST", Self.installation(id) + "/disconnect", json: .object([:]))
    }

    static func installation(_ id: String) -> String { "/v0/plugins/installations/\(escape(id))" }
}
