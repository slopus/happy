import Foundation
import HappyWire

/// A Happy Cloud server's inference connections (`GET /v0/cloud/providers`):
/// the operator's ("Happy (free)", `operator:<vendor>`), the team's (one per
/// vendor, its ID the vendor's, or named), and the person's own
/// (`private`, or named). A chat sends the connection's exact ID as
/// `Mode.providerId`. Secrets go in once and never come back: the phone
/// never holds a token a sign-in made.
public struct CloudProvider: Decodable, Equatable, Sendable {
    public enum Scope: String, Decodable, Sendable { case team, `private` }
    public enum Source: String, Decodable, Sendable { case `operator`, tenant }

    public struct Credential: Decodable, Equatable, Sendable {
        public var id: String
        public var vendor: String?
        public var kind: String?
        public var label: String?
        public var enabled: Bool
        public var state: String?

        enum CodingKeys: String, CodingKey { case id, credentialId, vendor, kind, label, enabled, state }

        public init(id: String, vendor: String? = nil, kind: String? = nil, label: String? = nil, enabled: Bool = true, state: String? = nil) {
            self.id = id; self.vendor = vendor; self.kind = kind; self.label = label; self.enabled = enabled; self.state = state
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decodeIfPresent(String.self, forKey: .credentialId) ?? c.decode(String.self, forKey: .id)
            vendor = try? c.decodeIfPresent(String.self, forKey: .vendor)
            kind = try? c.decodeIfPresent(String.self, forKey: .kind)
            label = try? c.decodeIfPresent(String.self, forKey: .label)
            enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? true
            state = try? c.decodeIfPresent(String.self, forKey: .state)
        }

        /// Refused by its vendor, or turned off: it serves nothing.
        public var needsAttention: Bool { state == "invalid" }

        /// The words a row shows for it.
        public var title: String {
            if let label, !label.isEmpty { return label }
            switch (vendor, kind) {
            case ("codex", _): return "ChatGPT"
            case ("claude-code", "oauth_token"): return "Claude (setup token)"
            case ("claude-code", _): return "Claude"
            case ("openai", _): return "OpenAI API key"
            case ("anthropic", _): return "Anthropic API key"
            case ("grok", _): return "Grok API key"
            default: return vendor ?? "Credential"
            }
        }
    }

    public var id: String
    public var name: String
    public var scope: Scope
    public var source: Source
    public var vendors: [String]
    public var models: [String]
    public var credentialCount: Int
    /// Serves at least one model for this person now (absent before the
    /// server says: then whether it has a vendor that serves).
    public var enabled: Bool
    /// Listed only for the person's own and, with `providers.manage`, the team's.
    public var credentials: [Credential]?

    enum CodingKeys: String, CodingKey { case id, name, scope, source, vendors, models, credentialCount, enabled, credentials }

    public init(id: String, name: String, scope: Scope, source: Source, vendors: [String] = [], models: [String] = [], credentialCount: Int = 0, enabled: Bool? = nil, credentials: [Credential]? = nil) {
        self.id = id; self.name = name; self.scope = scope; self.source = source
        self.vendors = vendors; self.models = models; self.credentialCount = credentialCount; self.credentials = credentials
        self.enabled = enabled ?? !vendors.isEmpty
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? id
        scope = (try? c.decodeIfPresent(Scope.self, forKey: .scope)) ?? .team
        source = (try? c.decodeIfPresent(Source.self, forKey: .source)) ?? .tenant
        vendors = (try? c.decodeIfPresent([String].self, forKey: .vendors)) ?? []
        models = (try? c.decodeIfPresent([String].self, forKey: .models)) ?? []
        credentialCount = (try? c.decodeIfPresent(Int.self, forKey: .credentialCount)) ?? 0
        credentials = try? c.decodeIfPresent([Credential].self, forKey: .credentials)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? !vendors.isEmpty
    }

    /// The person's own default connection.
    public static let personal = "private"

    /// Which of the list's sections it is in.
    public enum Section: Int, CaseIterable, Sendable { case included, team, mine }
    public var section: Section {
        if source == .operator { return .included }
        return scope == .private ? .mine : .team
    }

    /// Where a credential or sign-in goes: the person's own, or the team's
    /// container for `vendor`.
    public enum Destination: String, CaseIterable, Sendable {
        case mine = "private", team
        /// The container for it: the person's own, or the team's default for `vendor`.
        public func container(vendor: String) -> String { self == .mine ? CloudProvider.personal : vendor }
    }

    /// The destinations `gate` lets the person add to: their own with
    /// `providers.own`, the team's with `providers.manage`.
    public static func destinations(_ gate: RoleGate) -> [Destination] {
        Destination.allCases.filter { gate.allows($0 == .mine ? .providersOwn : .providersManage) }
    }

    /// A list in the screen's order: Included, Team, My account; by name inside.
    public static func sorted(_ providers: [CloudProvider]) -> [CloudProvider] {
        providers.sorted { ($0.section.rawValue, $0.name.lowercased()) < ($1.section.rawValue, $1.name.lowercased()) }
    }
}

extension CloudProvider {
    /// What a picker calls it: the operator's is "Happy (free)", the
    /// person's own "My account", the rest their own names.
    public var displayName: String {
        if source == .operator { return name.isEmpty ? "Happy (free)" : name }
        if id == CloudProvider.personal { return "My account" }
        return name
    }
}

extension ModelCatalog {
    /// On Happy Cloud a chat runs on a named connection (ONBOARDING-API §1):
    /// the pickers offer the connections, each with the models it serves,
    /// and send its exact ID as `Mode.providerId`. A model the
    /// configuration doesn't define is left out. A list with no connection
    /// keeps the configuration's own accounts.
    public func connections(_ listed: [CloudProvider]) -> ModelCatalog {
        guard !listed.isEmpty else { return self }
        var catalog = self
        catalog.providers = CloudProvider.sorted(listed).map { connection in
            let offered = connection.models.compactMap { id in models.first { $0.id == id } }
            let vendor = connection.vendors.first ?? connection.id.replacingOccurrences(of: "operator:", with: "")
            return Provider(id: connection.id, name: connection.displayName, type: vendor, enabled: connection.enabled, hidden: false, models: offered)
        }
        return catalog
    }
}

/// A sign-in the server runs for a subscription (`/v0/provider-clis`,
/// ONBOARDING-API §4–5): ChatGPT's device code (`codex`), or Claude's page
/// whose code is pasted back (`claude`). The server keeps every token; the
/// phone shows the code and the page, and polls until it ends.
public struct CloudSignIn: Equatable, Sendable {
    public enum CLI: String, Sendable {
        case codex, claude
        var method: String { self == .codex ? "device" : "browser" }
    }
    public enum Status: String, Sendable { case running, waiting, succeeded, failed, cancelled }

    public var cli: CLI
    public var id: String
    public var status: Status
    public var url: URL?
    public var userCode: String?
    public var acceptsCode: Bool
    public var expiresAt: Date?
    public var errorCode: String?
    public var errorMessage: String?
    public var providerId: String?

    public init(cli: CLI, id: String, status: Status, url: URL? = nil, userCode: String? = nil, acceptsCode: Bool = false, expiresAt: Date? = nil,
                errorCode: String? = nil, errorMessage: String? = nil, providerId: String? = nil) {
        self.cli = cli; self.id = id; self.status = status; self.url = url; self.userCode = userCode; self.acceptsCode = acceptsCode
        self.expiresAt = expiresAt; self.errorCode = errorCode; self.errorMessage = errorMessage; self.providerId = providerId
    }

    /// The `providerCli` object's sign-in operation; nil when there is none.
    public init?(cli: CLI, _ object: JSONValue?) {
        let operation = object?["operation"]
        guard let id = operation?["id"]?.stringValue, operation?["kind"]?.stringValue.map({ $0 == "sign_in" }) ?? true else { return nil }
        let authorization = operation?["authorization"]
        let error = operation?["error"]
        self.init(
            cli: cli, id: id,
            // A status this build doesn't know yet is still going.
            status: operation?["status"]?.stringValue.flatMap(Status.init(rawValue:)) ?? .running,
            url: authorization?["url"]?.stringValue.flatMap(Self.web),
            userCode: authorization?["userCode"]?.stringValue,
            acceptsCode: authorization?["acceptsCode"]?.boolValue ?? false,
            expiresAt: authorization?["expiresAt"]?.numberValue.map { Date(timeIntervalSince1970: $0 / 1000) },
            errorCode: error?["code"]?.stringValue ?? error?.stringValue,
            errorMessage: error?["message"]?.stringValue ?? operation?["message"]?.stringValue,
            providerId: operation?["target"]?["providerId"]?.stringValue
        )
    }

    /// Only an https page opens: a server can't send the phone elsewhere.
    static func web(_ text: String) -> URL? {
        guard let url = URL(string: text), url.scheme?.lowercased() == "https", url.host?.isEmpty == false else { return nil }
        return url
    }

    public var ended: Bool { status == .succeeded || status == .failed || status == .cancelled }

    /// The words for a failed sign-in: the server's, or ONBOARDING-API's
    /// for its code (an unknown one reads as `sign_in_failed`).
    public var failureText: String {
        if let errorMessage, !errorMessage.isEmpty { return errorMessage }
        let vendor = cli == .codex ? "ChatGPT" : "Claude"
        switch errorCode {
        case "expired": return "The sign-in code expired. Start again."
        case "denied": return "The sign-in was declined on the vendor’s page."
        case "not_authorized": return "You no longer have permission to add this provider."
        case "interrupted": return "The server restarted during the sign-in. Start again."
        case "unavailable": return "\(vendor) couldn’t be reached. Try again."
        default: return "\(vendor) didn’t accept the sign-in. Try again."
        }
    }
}

/// What a server lets people add (`GET /v0/cloud/providers`'
/// `capabilities`, ONBOARDING-API §2): each way shows only when on. A
/// server that doesn't say offers API keys, the sign-ins its
/// `/v0/provider-clis` lists, and no setup token.
public struct CloudAddOffer: Equatable, Sendable {
    public var apiKeys: Bool
    public var setupToken: Bool
    public var signIns: Set<CloudSignIn.CLI>

    public init(apiKeys: Bool = true, setupToken: Bool = false, signIns: Set<CloudSignIn.CLI> = []) {
        self.apiKeys = apiKeys
        self.setupToken = setupToken
        self.signIns = signIns
    }

    /// From the server's `capabilities`; nil when it sent none.
    public init?(capabilities: JSONValue?) {
        guard let capabilities, capabilities.objectValue != nil else { return nil }
        func on(_ key: String) -> Bool { capabilities[key]?.boolValue == true }
        self.init(apiKeys: on("apiKeys"), setupToken: on("claudeSetupToken"),
                  signIns: Set([on("codexSignIn") ? .codex : nil, on("claudeSignIn") ? .claude : nil].compactMap { $0 }))
    }
}

/// A credential the server refused to store, with its words for why.
public struct CloudCredentialRefusal: Error, Equatable, Sendable {
    public var kind: String
    public var message: String
}

public struct CloudSignInDestinationConflict: LocalizedError, Equatable, Sendable {
    public var errorDescription: String? {
        "The sign-in is for a different connection. Finish or cancel it before choosing another connection."
    }
}

extension AgentClient {
    public func cloudProviders() async throws -> [CloudProvider] {
        try await cloudProviderListing().providers
    }

    /// The connections, and what the server lets people add when it says.
    public func cloudProviderListing() async throws -> (providers: [CloudProvider], offer: CloudAddOffer?) {
        struct Response: Decodable {
            let providers: [CloudProvider]
            let capabilities: JSONValue?
        }
        let response = try await decode(Response.self, "GET", "/v0/cloud/providers")
        return (response.providers, CloudAddOffer(capabilities: response.capabilities))
    }

    /// Checks and stores a secret the person typed (an API key, Claude's
    /// setup token) in `container`. It is sent once and kept nowhere here.
    public func addCloudCredential(container: String, vendor: String, kind: String, secret: String) async throws {
        let body: JSONValue = .object(["vendor": .string(vendor), "kind": .string(kind), "secret": .string(secret)])
        do {
            _ = try await send("POST", "/v0/cloud/providers/\(Self.escape(container))/credentials", json: body)
        } catch AgentClientError.status(let status, let code, let message) where (400..<500).contains(status) && status != 403 {
            throw CloudCredentialRefusal(kind: code ?? "invalid", message: message ?? "The credential could not be added.")
        }
    }

    /// Where a sign-in or import stores its result.
    static func target(_ container: String) -> JSONValue {
        container == CloudProvider.personal ? .object(["scope": .string("private")]) : .object(["providerId": .string(container)])
    }

    private static func mutation() -> JSONValue { .string("ios-" + UUID().uuidString.lowercased()) }

    private func signIn(_ cli: CloudSignIn.CLI, _ method: String, _ path: String, json: JSONValue? = nil) async throws -> CloudSignIn {
        let value = try await decode(JSONValue.self, method, path, json: json)
        guard let signIn = CloudSignIn(cli: cli, value["providerCli"]) else { throw AgentClientError.invalidResponse }
        return signIn
    }

    /// Starts (or joins the person's running) sign-in for `cli` into
    /// `container`. A server without it answers 404 or 501.
    public func startCloudSignIn(_ cli: CloudSignIn.CLI, container: String) async throws -> CloudSignIn {
        let started = try await signIn(cli, "POST", "/v0/provider-clis/\(cli.rawValue)/sign-in", json: .object([
            "method": .string(cli.method), "target": Self.target(container), "mutationId": Self.mutation(),
        ]))
        guard started.providerId == container else { throw CloudSignInDestinationConflict() }
        return started
    }

    public func cloudSignIn(_ cli: CloudSignIn.CLI) async throws -> CloudSignIn {
        try await signIn(cli, "GET", "/v0/provider-clis/\(cli.rawValue)")
    }

    /// Claude's code, pasted back from its page.
    public func finishCloudSignIn(_ cli: CloudSignIn.CLI, code: String) async throws -> CloudSignIn {
        try await signIn(cli, "POST", "/v0/provider-clis/\(cli.rawValue)/sign-in/code", json: .object(["code": .string(code), "mutationId": Self.mutation()]))
    }

    public func cancelCloudSignIn(_ cli: CloudSignIn.CLI) async {
        _ = try? await send("POST", "/v0/provider-clis/\(cli.rawValue)/cancel", json: .object(["mutationId": Self.mutation()]))
    }

    /// Polls the sign-in every 3 seconds until it ends, `tick` hearing each
    /// reading. A reading that fails on the network is tried again.
    public func waitForCloudSignIn(_ start: CloudSignIn, every interval: Double = 3, sleep: @Sendable (Double) async throws -> Void = { try await Task.sleep(for: .seconds($0)) },
                                   tick: @Sendable (CloudSignIn) -> Void = { _ in }) async throws -> CloudSignIn {
        var current = start
        while !current.ended {
            try await sleep(interval)
            try Task.checkCancellation()
            do {
                let next = try await cloudSignIn(current.cli)
                // Another flow replaced this one: it ended for us.
                current = next.id == current.id ? next : CloudSignIn(cli: current.cli, id: current.id, status: .cancelled)
            }
            catch let error as AgentClientError { throw error }
            catch { continue }
            tick(current)
        }
        return current
    }

    /// The provider CLIs a server lists (`GET /v0/provider-clis`): which
    /// sign-ins it runs.
    public func providerCLIs() async throws -> [String] {
        let value = try await decode(JSONValue.self, "GET", "/v0/provider-clis")
        let list = value["providerClis"]?.arrayValue ?? value.arrayValue ?? []
        return list.compactMap { $0["id"]?.stringValue }
    }

    /// Whether `error` says the server has no such sign-in yet: hide it.
    public static func unavailable(_ error: any Error) -> Bool {
        guard case AgentClientError.status(let status, let code, _) = error else { return false }
        return status == 404 || status == 501 || code == "machine_local" || code == "unsupported"
    }
}
