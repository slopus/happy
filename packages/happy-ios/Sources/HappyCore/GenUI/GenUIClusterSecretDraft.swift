import Foundation
import HappyWire

/// A Happy Cloud secret as the cluster shows it (API.md, "Secrets"): its
/// public metadata, never its material.
public struct ClusterSecret: Equatable, Sendable, Decodable {
    public var id: String
    public var type: String
    public var name: String
    public var description: String?
    public var `public`: JSONValue?
    public var uses: [String]?
    public var owner: String?
    public var version: String
}

/// What a cluster secret form's save did (`201`, or `200` for a retry):
/// the secret, which is nil when the caller can no longer see it.
public struct GenUIClusterSecretSaved: Equatable, Sendable {
    public var secret: ClusterSecret?
    public var secretId: String
    public var granted: Bool
}

/// The Happy Cloud secret form a Gen UI `cluster_secret` action opens, as
/// the person edits it (SPEC.md, "Secret actions"; the cluster's API.md,
/// "Gen UI actions"): its type is the action's, every other field starts
/// from the prefill, or from the stored secret the action names, and may
/// change. Lists are edited as text, one item per comma or line.
///
/// Values are typed here and leave only in `body()`'s one request. The
/// cluster checks the rest (host syntax, header names, which uses fit,
/// that only an SSH key signs) and says what it refused.
public struct GenUIClusterSecretDraft: Equatable, Sendable {
    public typealias Kind = GenUIClusterSecretPrefill.Kind

    public struct Target: Equatable, Sendable, Identifiable {
        public let id: Int
        public var host = ""
        /// Comma-separated.
        public var ports = ""
        public var paths = ""
        public var methods = ""
    }

    /// One header the proxy sets, and its value.
    public struct Header: Equatable, Sendable, Identifiable {
        public let id: Int
        public var name = ""
        public var prefix = ""
        public var value = ""
    }

    public struct Variable: Equatable, Sendable, Identifiable {
        public let id: Int
        public var name = ""
        public var value = ""
        /// Stored under this name: left empty, it keeps its value.
        public var stored = false
    }

    public enum Method: String, CaseIterable, Sendable { case sshKey = "ssh_key", password, token }

    /// What stops a save, said by the field it is about.
    public enum Problem: Hashable, Sendable {
        case name, description, uses, targets, headers, hosts, server, port, variables, value
    }

    public let kind: Kind
    /// The stored secret the action names, which the form changes.
    public private(set) var stored: ClusterSecret?
    public var name: String
    public var description: String
    /// `me` unless the action said `team`; a change keeps the stored owner.
    public var owner: GenUIClusterSecretPrefill.Owner
    public var uses: Set<String>
    // endpoint
    public var targets: [Target] = []
    public var headers: [Header] = []
    // ssh_key
    public var hosts = ""
    public var sshPorts = ""
    /// Pinned `known_hosts` lines, for an SSH key or git over SSH.
    public var knownHosts: [String] = []
    // git_credential
    public var server = ""
    public var port = ""
    public var method = Method.token
    public var username = ""
    public var repos = ""
    public var operations: Set<String> = ["read"]
    // environment
    public var variables: [Variable] = []
    // material
    public var privateKey = ""
    public var passphrase = ""
    public var password = ""
    public var token = ""
    private var nextId = 0
    private var original: JSONValue?

    public init(_ prefill: GenUIClusterSecretPrefill) {
        kind = prefill.kind
        name = prefill.name
        description = prefill.description ?? ""
        owner = prefill.owner ?? .me
        uses = Set(prefill.uses ?? Array(kind.uses).filter { $0 != "mcp" })
        read(prefill.metadata ?? [:])
        if kind == .endpoint, targets.isEmpty { addTarget() }
        if kind == .endpoint, headers.isEmpty { addHeader() }
        if kind == .environment, variables.isEmpty { addVariable() }
    }

    public var changing: Bool { stored != nil }
    /// Opened on the secret this element saved before: a save makes the
    /// cluster change it (a create body, every value again).
    public private(set) var resaving = false

    /// Opens the form on `secret`, the stored one the action names: what it
    /// holds, under what the action suggests changing.
    public mutating func adopt(_ secret: ClusterSecret, suggested prefill: GenUIClusterSecretPrefill) {
        stored = secret
        show(secret)
        original = metadata
        if !prefill.name.isEmpty { name = prefill.name }
        if let suggested = prefill.description { description = suggested }
        if let suggested = prefill.uses { uses = Set(suggested) }
        if let suggested = prefill.metadata { read(suggested) }
        if kind == .environment {
            for index in variables.indices { variables[index].stored = true }
        }
    }

    /// Opens the form on `secret`, which this element's form saved before,
    /// as the person left it; a save changes it again.
    public mutating func reopen(_ secret: ClusterSecret) {
        show(secret)
        resaving = true
    }

    private mutating func show(_ secret: ClusterSecret) {
        name = secret.name
        description = secret.description ?? ""
        owner = secret.owner == "team" ? .team : .me
        uses = Set(secret.uses ?? Array(uses))
        targets = []
        headers = []
        variables = []
        read(secret.public?.objectValue ?? [:])
        if kind == .endpoint, targets.isEmpty { addTarget() }
        if kind == .endpoint, headers.isEmpty { addHeader() }
        if kind == .environment, variables.isEmpty { addVariable() }
    }

    // MARK: Lists

    public mutating func addTarget() { targets.append(Target(id: take())) }
    public mutating func addHeader() { headers.append(Header(id: take())) }
    public mutating func addVariable() { variables.append(Variable(id: take())) }
    public mutating func removeTarget(_ id: Int) { targets.removeAll { $0.id == id } }
    public mutating func removeHeader(_ id: Int) { headers.removeAll { $0.id == id } }
    public mutating func removeVariable(_ id: Int) { variables.removeAll { $0.id == id } }

    private mutating func take() -> Int {
        defer { nextId += 1 }
        return nextId
    }

    /// Reads a type's public metadata into the fields.
    private mutating func read(_ metadata: [String: JSONValue]) {
        func list(_ value: JSONValue?, _ separator: String = ", ") -> String {
            (value?.arrayValue ?? []).map { $0.stringValue ?? $0.numberValue.map { String(Int($0)) } ?? "" }.joined(separator: separator)
        }
        switch kind {
        case .endpoint:
            if let list = metadata["targets"]?.arrayValue {
                targets = list.map { target in
                    var row = Target(id: take())
                    row.host = target["host"]?.stringValue ?? ""
                    row.ports = GenUIClusterSecretDraft.join(target["ports"])
                    row.paths = GenUIClusterSecretDraft.join(target["pathPrefixes"])
                    row.methods = GenUIClusterSecretDraft.join(target["methods"])
                    return row
                }
            }
            if let list = metadata["algorithm"]?["headers"]?.arrayValue {
                headers = list.map { header in
                    var row = Header(id: take())
                    row.name = header["name"]?.stringValue ?? ""
                    row.prefix = header["prefix"]?.stringValue ?? ""
                    return row
                }
            }
        case .sshKey:
            if metadata["hosts"] != nil { hosts = list(metadata["hosts"]) }
            if metadata["ports"] != nil { sshPorts = list(metadata["ports"]) }
            if let lines = metadata["knownHosts"]?.arrayValue { knownHosts = lines.compactMap(\.stringValue) }
        case .gitCredential:
            if let value = metadata["server"]?.stringValue { server = value }
            if let value = metadata["port"]?.numberValue { port = String(Int(value)) }
            if let value = metadata["method"] {
                method = value["kind"]?.stringValue.flatMap(Method.init(rawValue:)) ?? method
                username = value["username"]?.stringValue ?? ""
                if let lines = value["knownHosts"]?.arrayValue { knownHosts = lines.compactMap(\.stringValue) }
            }
            if metadata["repos"] != nil { repos = list(metadata["repos"]) }
            if let value = metadata["operations"]?.arrayValue { operations = Set(value.compactMap(\.stringValue)) }
        case .environment:
            if let names = metadata["variables"]?.arrayValue {
                variables = names.compactMap(\.stringValue).map { var row = Variable(id: take()); row.name = $0; return row }
            }
        }
    }

    private static func join(_ value: JSONValue?) -> String {
        (value?.arrayValue ?? []).map { $0.stringValue ?? $0.numberValue.map { String(Int($0)) } ?? "" }.joined(separator: ", ")
    }

    /// A comma- or line-separated list's items, trimmed, without empties.
    static func items(_ text: String) -> [String] {
        text.split(whereSeparator: { $0 == "," || $0.isNewline }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private static func ports(_ text: String) -> [JSONValue]? {
        var ports: [JSONValue] = []
        for item in items(text) {
            guard let port = Int(item), (1...65_535).contains(port) else { return nil }
            ports.append(.number(Double(port)))
        }
        return ports
    }

    // MARK: Checking and the request

    /// Whether a value left empty keeps the stored one: an endpoint's or
    /// environment secret's, when changing.
    public var keepsEmptyValues: Bool { changing && (kind == .endpoint || kind == .environment) && !movesValues }

    /// What material the method or type asks for.
    public var asksKey: Bool { kind == .sshKey || (kind == .gitCredential && method == .sshKey) }

    public var problems: Set<Problem> {
        var problems = Set<Problem>()
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed.count > 100 || trimmed != name { problems.insert(.name) }
        if description.count > GenUISecretPrefill.maxDescription { problems.insert(.description) }
        if uses.isEmpty || !uses.isSubset(of: kind.uses) { problems.insert(.uses) }
        switch kind {
        case .endpoint:
            if targets.isEmpty || targets.contains(where: { $0.host.trimmingCharacters(in: .whitespaces).isEmpty || Self.ports($0.ports) == nil }) { problems.insert(.targets) }
            if headers.isEmpty || headers.contains(where: { $0.name.trimmingCharacters(in: .whitespaces).isEmpty }) { problems.insert(.headers) }
            if headers.contains(where: { $0.value.isEmpty && !keepsEmptyValues }) { problems.insert(.value) }
        case .sshKey:
            if Self.items(hosts).isEmpty { problems.insert(.hosts) }
            if Self.ports(sshPorts) == nil { problems.insert(.port) }
            if privateKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { problems.insert(.value) }
        case .gitCredential:
            if server.trimmingCharacters(in: .whitespaces).isEmpty { problems.insert(.server) }
            if !port.isEmpty, Self.ports(port)?.count != 1 { problems.insert(.port) }
            switch method {
            case .sshKey: if privateKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { problems.insert(.value) }
            case .password: if password.isEmpty || username.isEmpty { problems.insert(.value) }
            case .token: if token.isEmpty { problems.insert(.value) }
            }
        case .environment:
            let names = variables.map(\.name)
            if names.isEmpty || names.contains(where: { !GenUISecretPrefill.isVariable($0) }) || Set(names.map { $0.lowercased() }).count != names.count {
                problems.insert(.variables)
            }
            if variables.contains(where: { $0.value.isEmpty && !($0.stored && keepsEmptyValues) }) { problems.insert(.value) }
        }
        return problems
    }

    /// The type's public metadata as the form holds it.
    public var metadata: JSONValue {
        func strings(_ text: String) -> JSONValue { .array(Self.items(text).map(JSONValue.string)) }
        switch kind {
        case .endpoint:
            return .object([
                "targets": .array(targets.map { target in
                    var object: [String: JSONValue] = ["host": .string(target.host.trimmingCharacters(in: .whitespaces))]
                    if let ports = Self.ports(target.ports), !ports.isEmpty { object["ports"] = .array(ports) }
                    if !Self.items(target.paths).isEmpty { object["pathPrefixes"] = strings(target.paths) }
                    if !Self.items(target.methods).isEmpty { object["methods"] = .array(Self.items(target.methods).map { .string($0.uppercased()) }) }
                    return .object(object)
                }),
                "algorithm": .object(["kind": .string("headers"), "headers": .array(headers.map { header in
                    var object: [String: JSONValue] = ["name": .string(header.name.trimmingCharacters(in: .whitespaces))]
                    if !header.prefix.isEmpty { object["prefix"] = .string(header.prefix) }
                    return .object(object)
                })]),
            ])
        case .sshKey:
            var object: [String: JSONValue] = ["hosts": strings(hosts)]
            if let ports = Self.ports(sshPorts), !ports.isEmpty { object["ports"] = .array(ports) }
            if !lines.isEmpty { object["knownHosts"] = .array(lines) }
            return .object(object)
        case .gitCredential:
            var methodObject: [String: JSONValue] = ["kind": .string(method.rawValue)]
            switch method {
            case .sshKey: if !lines.isEmpty { methodObject["knownHosts"] = .array(lines) }
            case .password, .token: if !username.isEmpty { methodObject["username"] = .string(username) }
            }
            var object: [String: JSONValue] = ["server": .string(server.trimmingCharacters(in: .whitespaces)), "method": .object(methodObject)]
            if let port = Int(port.trimmingCharacters(in: .whitespaces)) { object["port"] = .number(Double(port)) }
            if !Self.items(repos).isEmpty { object["repos"] = strings(repos) }
            object["operations"] = .array(["read", "write", "sign"].filter(operations.contains).map(JSONValue.string))
            return .object(object)
        case .environment:
            return .object([:])
        }
    }

    /// The pinned `known_hosts` lines typed, without empties.
    private var lines: [JSONValue] {
        knownHosts.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.map(JSONValue.string)
    }

    /// A pasted OpenSSH or PEM key as its lines again: a one-line field
    /// takes a key's line breaks as spaces, or drops them.
    public static func key(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let begin = trimmed.range(of: #"-----BEGIN [A-Z0-9 ]+-----"#, options: .regularExpression),
              let end = trimmed.range(of: #"-----END [A-Z0-9 ]+-----"#, options: .regularExpression), begin.upperBound <= end.lowerBound else { return trimmed }
        let body = trimmed[begin.upperBound..<end.lowerBound].filter { !$0.isWhitespace }
        var lines = [String(trimmed[begin])]
        var rest = Substring(body)
        while !rest.isEmpty {
            lines.append(String(rest.prefix(70)))
            rest = rest.dropFirst(70)
        }
        lines.append(String(trimmed[end]))
        return lines.joined(separator: "\n") + "\n"
    }

    /// The values typed, by what the type names them; nil for one left
    /// empty that keeps its stored value.
    public var material: JSONValue {
        switch kind {
        case .endpoint:
            return .object(Dictionary(headers.map { ($0.name.trimmingCharacters(in: .whitespaces), $0.value.isEmpty ? JSONValue.null : .string($0.value)) }) { first, _ in first })
        case .environment:
            return .object(Dictionary(variables.map { ($0.name, $0.value.isEmpty ? JSONValue.null : .string($0.value)) }) { first, _ in first })
        case .sshKey:
            return .object(["privateKey": .string(Self.key(privateKey)), "passphrase": passphrase.isEmpty ? .null : .string(passphrase)])
        case .gitCredential:
            switch method {
            case .sshKey: return .object(["privateKey": .string(Self.key(privateKey)), "passphrase": passphrase.isEmpty ? .null : .string(passphrase)])
            case .password: return .object(["password": .string(password)])
            case .token: return .object(["token": .string(token)])
            }
        }
    }

    /// The form as the actions route takes it. Making a secret, a create
    /// body of the action's type. Changing the stored one the action names,
    /// a change body and the `version` it changes: its public metadata only
    /// when it changed, which then needs every value again.
    public func body() -> JSONValue {
        var secret: [String: JSONValue] = [
            "name": .string(name),
            "description": .string(description.trimmingCharacters(in: .whitespacesAndNewlines)),
            "uses": .array(kind.uses.sorted().filter(uses.contains).map(JSONValue.string)),
            "material": material,
        ]
        if kind != .environment, stored == nil || original != metadata { secret["public"] = metadata }
        if let stored {
            secret["version"] = .string(stored.version)
        } else {
            secret["type"] = .string(kind.rawValue)
            secret["owner"] = .string(owner.rawValue)
        }
        return .object(secret)
    }

    /// Whether the change moves where values go, so each must be typed again.
    public var movesValues: Bool { changing && kind != .environment && original != metadata }

    /// Forgets every typed value, once saved or abandoned.
    public mutating func forget() {
        for index in headers.indices { headers[index].value = "" }
        for index in variables.indices { variables[index].value = "" }
        privateKey = ""
        passphrase = ""
        password = ""
        token = ""
    }
}

extension AgentClient {
    /// The cluster secret `id`, or nil when the caller can't see one
    /// (`GET /v0/cluster/secrets/:id`).
    public func clusterSecret(_ id: String) async throws -> ClusterSecret? {
        struct Answer: Decodable { let secret: ClusterSecret }
        do {
            return try await decode(Answer.self, "GET", "/v0/cluster/secrets/\(Self.escape(id))").secret
        } catch AgentClientError.status(404, _, _) {
            return nil
        }
    }

    /// Saves a Gen UI cluster secret form for `element` of a version, under
    /// the retry key `id`: the cluster stores it, grants it to the version's
    /// agent and tells it, in one change.
    public func saveClusterSecretAction(artifactId: String, version: Int, element: String, id: String, secret: JSONValue) async throws -> GenUIClusterSecretSaved {
        struct Answer: Decodable { let secret: ClusterSecret?; let secretId: String; let granted: Bool? }
        let body: JSONValue = .object(["id": .string(id), "element": .string(element), "secret": secret, "grant": .bool(true)])
        let answer = try await decode(Answer.self, "POST", "/v0/artifacts/\(Self.escape(artifactId))/versions/\(version)/actions", json: body)
        return GenUIClusterSecretSaved(secret: answer.secret, secretId: answer.secretId, granted: answer.granted ?? false)
    }
}
