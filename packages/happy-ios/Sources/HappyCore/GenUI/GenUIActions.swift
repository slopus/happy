import Foundation
import HappyWire

/// What activating an element asks the host to do (SPEC.md rule 7). The
/// renderer reports it with the element's key; the host decides, and draws
/// what it can't run disabled (`GenUIHost.enables`).
public enum GenUIAction: Equatable, Sendable {
    /// Send `text` as the person's next message to the origin agent.
    case message(String)
    case open(String)
    case copy(String)
    case tool(name: String, input: JSONValue)
    /// Open Happy Agent's secret form, prefilled.
    case secret(GenUISecretPrefill)
    /// Open Happy Cloud's secret form of one type, prefilled.
    case clusterSecret(GenUIClusterSecretPrefill)
    /// Open a plugin's page; the tap installs nothing.
    case plugin(id: String)
    /// A type this client doesn't know, or one that breaks its schema, such
    /// as a secret carrying a value: drawn, never run.
    case unsupported

    /// Nil only when there is no action at all.
    init?(_ json: JSONValue?) {
        guard let json else { return nil }
        self = Self.parse(json) ?? .unsupported
    }

    private static func parse(_ json: JSONValue) -> GenUIAction? {
        switch json["type"]?.stringValue {
        case "message": return json["text"]?.stringValue.map(GenUIAction.message)
        case "open": return json["url"]?.stringValue.map(GenUIAction.open)
        case "copy": return json["text"]?.stringValue.map(GenUIAction.copy)
        case "tool": return json["name"]?.stringValue.map { .tool(name: $0, input: json["input"] ?? .object([:])) }
        case "secret":
            guard json.closed("type", "secret") else { return nil }
            return GenUISecretPrefill(json["secret"]).map(GenUIAction.secret)
        case "cluster_secret":
            guard json.closed("type", "secret") else { return nil }
            return GenUIClusterSecretPrefill(json["secret"]).map(GenUIAction.clusterSecret)
        case "plugin":
            guard json.closed("type", "plugin"), let plugin = json["plugin"], plugin.closed("id"),
                  let id = plugin["id"]?.stringValue, !id.isEmpty else { return nil }
            return .plugin(id: id)
        default: return nil
        }
    }
}

/// What Happy Agent's secret form starts with: names and hints, never a
/// value. The person may change all of it.
public struct GenUISecretPrefill: Equatable, Sendable {
    public struct Variable: Equatable, Sendable {
        public var name: String
        public var description: String?

        public init(name: String, description: String? = nil) {
            self.name = name
            self.description = description
        }
    }

    public static let maxDescription = 2000
    public static let maxVariables = 64

    public var id: String?
    public var description: String?
    public var variables: [Variable]

    public init(id: String? = nil, description: String? = nil, variables: [Variable]) {
        self.id = id
        self.description = description
        self.variables = variables
    }

    /// A secret's name: 2–32 characters, a lowercase letter then lowercase
    /// letters, digits, `_` or `-`.
    public static func isName(_ id: String) -> Bool {
        id.wholeMatch(of: /[a-z][a-z0-9_-]{1,31}/) != nil
    }

    public static func isVariable(_ name: String) -> Bool {
        name.wholeMatch(of: /[A-Za-z_][A-Za-z0-9_]*/) != nil
    }

    /// Checked as strictly as the catalog: its objects are closed, so one
    /// with a `value` anywhere is no prefill.
    init?(_ json: JSONValue?) {
        guard let json, json.closed("id", "description", "variables"),
              let id = json.optionalString("id"), id.map(Self.isName) ?? true,
              let description = json.optionalString("description"), (description?.count ?? 0) <= Self.maxDescription,
              let list = json["variables"]?.arrayValue, (1...Self.maxVariables).contains(list.count) else { return nil }
        var variables: [Variable] = []
        for item in list {
            guard item.closed("name", "description"), let name = item["name"]?.stringValue, Self.isVariable(name),
                  let hint = item.optionalString("description"), (hint?.count ?? 0) <= Self.maxDescription else { return nil }
            variables.append(Variable(name: name, description: hint))
        }
        guard Set(variables.map { $0.name.lowercased() }).count == variables.count else { return nil }
        self.init(id: id, description: description, variables: variables)
    }
}

/// What Happy Cloud's secret form starts with, by the secret's type. Its
/// own keys are checked, so `material`, or any other place for a value,
/// makes it no prefill; its `public` metadata is the cluster's to check
/// when the form is saved (SPEC.md, "Secret actions").
public struct GenUIClusterSecretPrefill: Equatable, Sendable {
    public enum Kind: String, CaseIterable, Sendable {
        case endpoint
        case sshKey = "ssh_key"
        case gitCredential = "git_credential"
        case environment

        /// The parts of the system a secret of this type may be opened by.
        public var uses: Set<String> {
            switch self {
            case .endpoint: ["egress", "mcp"]
            case .sshKey: ["ssh"]
            case .gitCredential: ["git"]
            case .environment: ["environment", "mcp"]
            }
        }
    }

    public enum Owner: String, Sendable { case me, team }

    public var kind: Kind
    /// An existing secret to change; nil makes one.
    public var id: String?
    public var name: String
    public var description: String?
    /// Nil: the form starts at `me`.
    public var owner: Owner?
    public var uses: [String]?
    /// The type's public metadata as the action suggests it.
    public var metadata: [String: JSONValue]?

    public init(kind: Kind, id: String? = nil, name: String, description: String? = nil, owner: Owner? = nil, uses: [String]? = nil, metadata: [String: JSONValue]? = nil) {
        self.kind = kind
        self.id = id
        self.name = name
        self.description = description
        self.owner = owner
        self.uses = uses
        self.metadata = metadata
    }

    init?(_ json: JSONValue?) {
        guard let json, json.closed("type", "id", "name", "description", "owner", "uses", "public"),
              let kind = json["type"]?.stringValue.flatMap(Kind.init(rawValue:)),
              let name = json["name"]?.stringValue, (1...100).contains(name.count), name == name.trimmingCharacters(in: .whitespacesAndNewlines),
              !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let id = json.optionalString("id"), id.map({ $0.wholeMatch(of: /[a-z][a-z0-9]{23}/) != nil }) ?? true,
              let description = json.optionalString("description"), (description?.count ?? 0) <= GenUISecretPrefill.maxDescription,
              let owner = json.optionalString("owner"), owner.map({ Owner(rawValue: $0) != nil }) ?? true else { return nil }
        var uses: [String]?
        if let value = json["uses"] {
            guard let list = value.arrayValue?.compactMap(\.stringValue), list.count == value.arrayValue?.count, !list.isEmpty,
                  Set(list).count == list.count, Set(list).isSubset(of: kind.uses) else { return nil }
            uses = list
        }
        let metadata = json["public"]?.objectValue
        guard json["public"] == nil || metadata != nil else { return nil }
        self.init(kind: kind, id: id, name: name, description: description, owner: owner.flatMap(Owner.init(rawValue:)), uses: uses, metadata: metadata)
    }
}

/// Where a Gen UI version is shown, and what that server and version let
/// it run (SPEC.md rule 7, conformance `actions.json`). This is the rule
/// alone: a client also needs the means, such as a conversation to send a
/// message into.
public struct GenUIHost: Equatable, Sendable {
    /// Each serves its own secret action.
    public enum Server: Equatable, Sendable { case happyAgent, cluster }

    public var server: Server
    /// The version's `createdBy` names an agent: where `message` and the
    /// secret actions go.
    public var origin: Bool
    /// Health's `capabilities.artifactSecretActions`.
    public var secretActions: Bool
    /// Health's `capabilities.plugins`.
    public var plugins: Bool

    public init(server: Server, origin: Bool, secretActions: Bool, plugins: Bool) {
        self.server = server
        self.origin = origin
        self.secretActions = secretActions
        self.plugins = plugins
    }

    public init(server: Server, origin: Bool, served: GenUIServed) {
        self.init(server: server, origin: origin, secretActions: served.secretActions, plugins: served.plugins)
    }

    public func enables(_ action: GenUIAction) -> Bool {
        switch action {
        case .message: origin
        // The model wrote the address: only https opens.
        case .open(let url): URL(string: url)?.scheme?.lowercased() == "https"
        case .copy: true
        case .plugin: plugins
        case .secret: origin && server == .happyAgent && secretActions
        case .clusterSecret: origin && server == .cluster && secretActions
        case .tool, .unsupported: false
        }
    }
}

/// What a server says it runs of Gen UI's actions, from its health's
/// `capabilities`; what it doesn't report it doesn't run. Never probed.
public struct GenUIServed: Equatable, Sendable {
    public var secretActions: Bool
    public var plugins: Bool

    public init(secretActions: Bool = false, plugins: Bool = false) {
        self.secretActions = secretActions
        self.plugins = plugins
    }

    public init(_ capabilities: AgentWire.Health.Capabilities?) {
        self.init(secretActions: capabilities?.artifactSecretActions == true, plugins: capabilities?.plugins == true)
    }
}

extension JSONValue {
    /// An object holding no key but `allowed`.
    fileprivate func closed(_ allowed: String...) -> Bool {
        objectValue.map { $0.keys.allSatisfy(allowed.contains) } ?? false
    }

    /// `.some(nil)` for an absent key, `.some(text)` for a string; nil for
    /// anything else, which breaks the schema.
    fileprivate func optionalString(_ key: String) -> String?? {
        guard let value = self[key] else { return .some(nil) }
        return value.stringValue.map { .some($0) }
    }
}
