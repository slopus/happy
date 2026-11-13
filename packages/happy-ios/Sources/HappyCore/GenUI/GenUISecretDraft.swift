import Foundation
import HappyWire

/// A Happy Agent secret as the computer shows it (API.md, "The secret
/// object"): its names, never its values.
public struct StoredSecret: Equatable, Sendable, Decodable {
    public var id: String
    public var description: String
    public var environmentVariables: [String]
    public var managed: Bool
    public var availableToAgents: Bool
    /// What a change names as `ifMatch`.
    public var version: String

    public init(id: String, description: String, environmentVariables: [String], managed: Bool = false, availableToAgents: Bool = true, version: String) {
        self.id = id
        self.description = description
        self.environmentVariables = environmentVariables
        self.managed = managed
        self.availableToAgents = availableToAgents
        self.version = version
    }

    /// One a person may change here: not another feature's, and open to agents.
    public var changeable: Bool { !managed && availableToAgents }
}

/// What a secret form's save did: the secret as it now stands, and whether
/// it was made or changed.
public struct GenUISecretSaved: Equatable, Sendable {
    public var secret: StoredSecret
    public var created: Bool
}

/// The Happy Agent secret form a Gen UI `secret` action opens, as the person
/// edits it (SPEC.md, "Secret actions"): it starts from the action's
/// prefill and every field may change; variables may be added, removed and
/// renamed. When its name is a stored secret (`adopt`) the form changes
/// that secret, and a value left empty keeps what is stored.
///
/// Values live here and in the one request `form` makes, nowhere else.
public struct GenUISecretDraft: Equatable, Sendable {
    /// One variable: its name, the agent's hint, the value typed, and the
    /// stored variable it stands for when changing.
    public struct Row: Equatable, Sendable, Identifiable {
        public let id: Int
        public var name: String
        public let hint: String?
        public var value = ""
        public var stored: String?
        /// Came from the stored secret rather than the action.
        public let fromStore: Bool

        /// Changing, a row left empty keeps what is stored under its name.
        public var keeps: Bool { stored != nil && stored == name }
    }

    /// What stops a save, each said once by the field it is about.
    public enum Problem: Hashable, Sendable {
        case name, description, noVariables, variableName, variableTwice, value, managed
    }

    /// API.md: a secret holds at most 256 variables, each value at most 65,536 characters.
    public static let maxVariables = 256
    public static let maxValue = 65_536

    public var name: String
    public private(set) var description: String
    public private(set) var rows: [Row] = []
    /// The stored secret `name` names; nil when there is none, or it isn't known yet.
    public private(set) var existing: StoredSecret?
    private let prefill: GenUISecretPrefill
    private var describedByHand = false
    private var nextId = 0

    /// Opens on `name`, a secret saved from this element before, or the prefill's.
    public init(_ prefill: GenUISecretPrefill, name: String? = nil) {
        self.prefill = prefill
        self.name = name ?? prefill.id ?? ""
        description = prefill.description ?? ""
        for variable in prefill.variables { append(name: variable.name, hint: variable.description, stored: nil, fromStore: false) }
    }

    public var changing: Bool { existing != nil }

    public mutating func describe(_ text: String) {
        description = text
        describedByHand = true
    }

    public mutating func add() {
        append(name: "", hint: nil, stored: nil, fromStore: false)
    }

    public mutating func remove(_ id: Int) {
        rows.removeAll { $0.id == id }
    }

    public mutating func rename(_ id: Int, to name: String) {
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
        rows[index].name = name
    }

    public mutating func type(_ id: Int, _ value: String) {
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
        rows[index].value = value
    }

    private mutating func append(name: String, hint: String?, stored: String?, fromStore: Bool) {
        rows.append(Row(id: nextId, name: name, hint: hint, stored: stored, fromStore: fromStore))
        nextId += 1
    }

    /// Opens the form on `secret`, the one `name` now names, or back on a
    /// new one for nil: its stored variables join the rows, kept unless
    /// typed over, and its description shows unless the person wrote one.
    public mutating func adopt(_ secret: StoredSecret?) {
        existing = secret
        guard let secret else {
            rows.removeAll { $0.fromStore && $0.value.isEmpty && $0.keeps }
            for index in rows.indices { rows[index].stored = nil }
            if !describedByHand { description = prefill.description ?? "" }
            return
        }
        var left = secret.environmentVariables
        for index in rows.indices {
            let match = left.first { $0.lowercased() == rows[index].name.lowercased() }
            rows[index].stored = match
            if let match {
                left.removeAll { $0 == match }
                rows[index].name = match
            }
        }
        for name in left { append(name: name, hint: nil, stored: name, fromStore: true) }
        if !describedByHand, !secret.description.isEmpty { description = secret.description }
    }

    /// Whether `row` still needs a value: always when making a secret, and
    /// a new or renamed one when changing.
    public func missing(_ row: Row) -> Bool {
        row.value.isEmpty && !(existing != nil && row.keeps)
    }

    /// Everything that stops a save; empty when it may go.
    public var problems: Set<Problem> {
        var problems = Set<Problem>()
        if !GenUISecretPrefill.isName(name) { problems.insert(.name) }
        let described = description.trimmingCharacters(in: .whitespacesAndNewlines).count
        if !(1...GenUISecretPrefill.maxDescription).contains(described) { problems.insert(.description) }
        if rows.isEmpty || rows.count > Self.maxVariables { problems.insert(.noVariables) }
        if rows.contains(where: { !GenUISecretPrefill.isVariable($0.name) }) { problems.insert(.variableName) }
        if Set(rows.map { $0.name.lowercased() }).count != rows.count { problems.insert(.variableTwice) }
        if rows.contains(where: { missing($0) || $0.value.count > Self.maxValue || $0.value.contains("\0") }) { problems.insert(.value) }
        if existing?.changeable == false { problems.insert(.managed) }
        return problems
    }

    /// The form as the actions route takes it. Making a secret, the whole
    /// bundle. Changing one, a patch: a typed value sets, a row left empty
    /// keeps, a removed or renamed stored variable is `null`; and the
    /// stored version as `ifMatch`.
    public func form() -> (secret: JSONValue, ifMatch: String?) {
        var environment: [String: JSONValue] = [:]
        if let existing {
            let kept = Set(rows.compactMap { $0.keeps ? $0.stored : nil })
            for name in existing.environmentVariables where !kept.contains(name) { environment[name] = .null }
            for row in rows where !row.value.isEmpty { environment[row.name] = .string(row.value) }
        } else {
            for row in rows { environment[row.name] = .string(row.value) }
        }
        let secret: JSONValue = .object([
            "id": .string(name),
            "description": .string(description.trimmingCharacters(in: .whitespacesAndNewlines)),
            "environment": .object(environment),
        ])
        return (secret, existing?.version)
    }

    /// Forgets every typed value, once saved or abandoned.
    public mutating func forget() {
        for index in rows.indices { rows[index].value = "" }
    }
}

extension AgentClient {
    /// The secret `id`, or nil when there is none (`GET /v0/secrets/:id`).
    public func secret(_ id: String) async throws -> StoredSecret? {
        struct Answer: Decodable { let secret: StoredSecret }
        do {
            return try await decode(Answer.self, "GET", "/v0/secrets/\(Self.escape(id))").secret
        } catch AgentClientError.status(404, _, _) {
            return nil
        }
    }

    /// Saves a Gen UI secret form for `element` of a version, under the
    /// retry key `id` (`POST /v0/artifacts/:id/versions/:n/actions`): the
    /// computer stores it, gives the version's agent access and tells it,
    /// in one change. The action itself is never sent; the computer reads
    /// it from the stored document.
    public func saveSecretAction(artifactId: String, version: Int, element: String, id: String, secret: JSONValue, ifMatch: String?) async throws -> GenUISecretSaved {
        struct Answer: Decodable { let secret: StoredSecret; let outcome: String }
        var body: [String: JSONValue] = ["id": .string(id), "element": .string(element), "secret": secret, "mutationId": .string(ClientID.make())]
        if let ifMatch { body["ifMatch"] = .string(ifMatch) }
        let answer = try await decode(Answer.self, "POST", "/v0/artifacts/\(Self.escape(artifactId))/versions/\(version)/actions", json: .object(body))
        return GenUISecretSaved(secret: answer.secret, created: answer.outcome == "created")
    }
}
