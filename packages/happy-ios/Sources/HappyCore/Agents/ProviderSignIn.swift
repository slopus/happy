import Foundation
import HappyWire

/// Where a computer's Codex, Claude or Grok account gets its credential
/// (`GET /v0/config` `credential`, API.md "Provider sign-in"): the
/// machine's own login, one this installation signed in and owns, or one
/// its configuration names. Only from a daemon whose health says
/// `capabilities.providerSignIn`.
public struct ProviderCredential: Equatable, Sendable {
    public enum Source: String, Sendable {
        case `internal`, system, configured
    }

    public var source: Source
    /// The sign-in methods the daemon takes, in the order it prefers them.
    public var methods: [String]
    /// Whether `PUT /v0/providers/:id/token` takes a pasted token (Claude).
    public var acceptsToken: Bool

    public init(source: Source, methods: [String] = [], acceptsToken: Bool = false) {
        self.source = source
        self.methods = methods
        self.acceptsToken = acceptsToken
    }

    /// Nil when there is none. A source this build doesn't know is
    /// `configured`, as API.md says.
    public init?(_ value: JSONValue?) {
        guard let value, value.objectValue != nil else { return nil }
        self.init(
            source: value["source"]?.stringValue.flatMap(Source.init(rawValue:)) ?? .configured,
            methods: value["methods"]?.arrayValue?.compactMap(\.stringValue) ?? [],
            acceptsToken: value["acceptsToken"]?.boolValue ?? false
        )
    }

    /// The method a phone signs `cli` in with: `device` wherever it is
    /// offered, else Claude's `browser`, whose page shows a code to paste
    /// back. Codex's and Grok's `browser` finishes on a page served on the
    /// computer, so a phone never offers it.
    public func phoneMethod(cli: String) -> String? {
        if methods.contains("device") { return "device" }
        if cli == "claude", methods.contains("browser") { return "browser" }
        return nil
    }
}

/// One account a computer's configuration lists that signs in with a
/// vendor's subscription: of type `codex`, `claude` or `grok`, with a
/// `credential`.
public struct ProviderAccount: Equatable, Sendable {
    public var id: String
    /// Its friendly name, when it has one.
    public var name: String?
    /// `codex`, `claude` or `grok`: the program that signs it in.
    public var type: String
    /// Switched on in the configuration; off, nothing runs on it.
    public var enabled: Bool
    public var credential: ProviderCredential

    public init(id: String, name: String? = nil, type: String, enabled: Bool = true, credential: ProviderCredential) {
        self.id = id
        self.name = name
        self.type = type
        self.enabled = enabled
        self.credential = credential
    }

    public static let types: Set<String> = ["codex", "claude", "grok"]

    /// The accounts in `GET /v0/config`'s bytes, in the daemon's order. An
    /// account without `credential` comes from an older daemon: left out.
    public static func list(config data: Data) -> [ProviderAccount] {
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              let providers = value["config"]?["providers"]?.objectValue else { return [] }
        let order = JSONKeyOrder.keys(in: data, at: ["config", "providers"])
        let ids = order.filter { providers[$0] != nil } + providers.keys.filter { !order.contains($0) }.sorted()
        return ids.compactMap { id in
            guard let entry = providers[id], let type = entry["type"]?.stringValue, types.contains(type),
                  let credential = ProviderCredential(entry["credential"]) else { return nil }
            return ProviderAccount(id: id, name: entry["name"]?.stringValue, type: type, enabled: entry["enabled"]?.boolValue ?? false, credential: credential)
        }
    }
}

/// One account's sign-in into a credential this installation owns
/// (`providerSignIn`, API.md "The provider sign-in object"). The phone
/// never holds a credential: it shows the vendor's page and code, hands a
/// pasted code or token on once, and follows the daemon to the end.
public struct ProviderSignIn: Equatable, Sendable {
    public struct Account: Equatable, Sendable {
        public var email: String?
        public var plan: String?

        public init(email: String? = nil, plan: String? = nil) {
            self.email = email
            self.plan = plan
        }
    }

    /// The provider-CLI operation object, always of kind `sign_in`.
    public struct Operation: Equatable, Sendable {
        public enum Status: String, Sendable { case running, waiting, succeeded, failed, cancelled }

        public var id: String
        public var status: Status
        public var message: String?
        /// `device` or `browser`, once the vendor's program gave its page.
        public var method: String?
        public var url: URL?
        public var userCode: String?
        public var acceptsCode: Bool
        public var expiresAt: Date?
        public var errorCode: String?
        public var errorMessage: String?

        public init(id: String, status: Status, message: String? = nil, method: String? = nil, url: URL? = nil, userCode: String? = nil,
                    acceptsCode: Bool = false, expiresAt: Date? = nil, errorCode: String? = nil, errorMessage: String? = nil) {
            self.id = id; self.status = status; self.message = message; self.method = method; self.url = url
            self.userCode = userCode; self.acceptsCode = acceptsCode; self.expiresAt = expiresAt
            self.errorCode = errorCode; self.errorMessage = errorMessage
        }

        init?(_ value: JSONValue?) {
            guard let value, let id = value["id"]?.stringValue else { return nil }
            let authorization = value["authorization"]
            let error = value["error"]
            self.init(
                id: id,
                // A status this build doesn't know yet is still going.
                status: value["status"]?.stringValue.flatMap(Status.init(rawValue:)) ?? .running,
                message: value["message"]?.stringValue,
                method: authorization?["method"]?.stringValue,
                url: authorization?["url"]?.stringValue.flatMap(CloudSignIn.web),
                userCode: authorization?["userCode"]?.stringValue,
                acceptsCode: authorization?["acceptsCode"]?.boolValue ?? false,
                expiresAt: authorization?["expiresAt"]?.numberValue.map { Date(timeIntervalSince1970: $0 / 1000) },
                errorCode: error?["code"]?.stringValue,
                errorMessage: error?["message"]?.stringValue
            )
        }

        public var ended: Bool { status == .succeeded || status == .failed || status == .cancelled }
    }

    public var providerId: String
    public var cliId: String
    public var installed: Bool
    public var credential: ProviderCredential
    public var account: Account?
    public var operation: Operation?
    /// UUIDv7: of two, the greater is newer.
    public var version: String
    public var updatedAt: Date

    public init(providerId: String, cliId: String, installed: Bool = true, credential: ProviderCredential, account: Account? = nil,
                operation: Operation? = nil, version: String, updatedAt: Date = Date(timeIntervalSince1970: 0)) {
        self.providerId = providerId; self.cliId = cliId; self.installed = installed; self.credential = credential
        self.account = account; self.operation = operation; self.version = version; self.updatedAt = updatedAt
    }

    public init?(_ value: JSONValue?) {
        guard let value, let providerId = value["providerId"]?.stringValue, let cliId = value["cliId"]?.stringValue,
              let credential = ProviderCredential(value["credential"]), let version = value["version"]?.stringValue else { return nil }
        let account = value["account"].flatMap { $0.objectValue == nil ? nil : Account(email: $0["email"]?.stringValue, plan: $0["plan"]?.stringValue) }
        self.init(
            providerId: providerId, cliId: cliId,
            installed: value["installed"]?.boolValue ?? true,
            credential: credential, account: account,
            operation: Operation(value["operation"]),
            version: version,
            updatedAt: Date(timeIntervalSince1970: (value["updatedAt"]?.numberValue ?? 0) / 1000)
        )
    }

    /// Whether this is newer than `other`: snapshots and events are both
    /// whole objects, and the greater version wins.
    public func isNewer(than other: ProviderSignIn?) -> Bool {
        guard let other else { return true }
        return version.lowercased() > other.version.lowercased()
    }

    /// `next` where it is newer than what is kept for its account.
    public static func keep(_ next: ProviderSignIn, in kept: inout [String: ProviderSignIn]) -> Bool {
        guard next.isNewer(than: kept[next.providerId]) else { return false }
        kept[next.providerId] = next
        return true
    }

    /// The object a `provider_sign_in.updated` event carries.
    public static func fromEvent(_ envelope: JSONValue) -> ProviderSignIn? {
        guard envelope["type"]?.stringValue == updatedEvent else { return nil }
        return ProviderSignIn(envelope["payload"]?["providerSignIn"])
    }

    public static let updatedEvent = "provider_sign_in.updated"

    /// What a sign-in screen shows for an operation.
    public enum Phase: Equatable, Sendable {
        /// Started; the vendor's page isn't known yet.
        case starting
        /// A code to type at `url`.
        case device(code: String?, url: URL?)
        /// A page that shows a code to paste back (Claude).
        case pasteCode(url: URL?)
        /// A page served on the computer: finished there, or cancelled.
        case onComputer
        case succeeded(Account?)
        case failed(code: String?, message: String?)
        case cancelled
    }

    public var phase: Phase { Self.phase(operation, account: account) }

    public static func phase(_ operation: Operation?, account: Account? = nil) -> Phase {
        guard let operation else { return .starting }
        switch operation.status {
        case .succeeded: return .succeeded(account)
        case .failed: return .failed(code: operation.errorCode, message: operation.errorMessage)
        case .cancelled: return .cancelled
        case .running, .waiting:
            // A code already handed on runs on with its page: still there.
            guard operation.url != nil || operation.userCode != nil else { return .starting }
            if operation.method == "device" || (operation.userCode != nil && !operation.acceptsCode) {
                return .device(code: operation.userCode, url: operation.url)
            }
            return operation.acceptsCode ? .pasteCode(url: operation.url) : .onComputer
        }
    }
}

/// Why a sign-in route said no, from its error code.
public enum ProviderSignInRefusal: Equatable, Sendable {
    /// Team mode: only the team owner may change how accounts sign in.
    case ownerOnly
    /// The vendor's program isn't installed on the computer.
    case notInstalled
    /// The account can't sign in, or takes no token.
    case notSupported
    /// The code wasn't wanted: nothing is waiting for one.
    case conflict
    /// A malformed token or method.
    case invalid(String?)
    /// Anything else, with the daemon's words when it gave some.
    case other(String?)

    public init(_ error: any Error) {
        guard case AgentClientError.status(let status, let code, let message) = error else {
            self = .other(nil)
            return
        }
        switch (status, code) {
        case (403, "forbidden"): self = .ownerOnly
        case (409, "not_installed"): self = .notInstalled
        case (409, "not_supported"), (404, _): self = .notSupported
        case (409, "conflict"): self = .conflict
        case (400, _): self = .invalid(message)
        default: self = .other(message)
        }
    }
}

extension AgentClient {
    /// Whether the daemon serves provider sign-in (`capabilities.providerSignIn`).
    public func servesProviderSignIn() async throws -> Bool {
        try await served()["capabilities"]?["providerSignIn"]?.boolValue == true
    }

    /// The accounts that sign in with a subscription, from `GET /v0/config`.
    public func providerAccounts() async throws -> [ProviderAccount] {
        ProviderAccount.list(config: try await send("GET", "/v0/config").body)
    }

    /// How each account's login is doing, by provider ID, from `GET /v0/usage`.
    public func providerAccountHealth() async throws -> [String: ProviderAccountHealth] {
        ProviderAccountHealth.read(usage: try await usageResponse())
    }

    /// Switches an account on or off (`PATCH /v0/config` `providers`): a
    /// durable override of the daemon's scans.
    public func setProviderEnabled(_ providerId: String, _ enabled: Bool) async throws {
        _ = try await send("PATCH", "/v0/config", json: .object(["providers": .object([providerId: .object(["enabled": .bool(enabled)])])]))
    }

    private static func signInPath(_ providerId: String, _ rest: String = "/sign-in") -> String {
        "/v0/providers/\(escape(providerId))\(rest)"
    }

    private static func signInMutation() -> JSONValue { .string("ios-" + UUID().uuidString.lowercased()) }

    private func providerSignIn(_ method: String, _ path: String, json: JSONValue? = nil) async throws -> ProviderSignIn {
        let value = try await decode(JSONValue.self, method, path, json: json)
        guard let signIn = ProviderSignIn(value["providerSignIn"]) else { throw AgentClientError.invalidResponse }
        return signIn
    }

    public func providerSignIn(_ providerId: String) async throws -> ProviderSignIn {
        try await providerSignIn("GET", Self.signInPath(providerId))
    }

    /// Starts the account's sign-in with `method`, or joins the one running.
    public func startProviderSignIn(_ providerId: String, method: String?) async throws -> ProviderSignIn {
        var body: [String: JSONValue] = ["mutationId": Self.signInMutation()]
        if let method { body["method"] = .string(method) }
        return try await providerSignIn("POST", Self.signInPath(providerId), json: .object(body))
    }

    /// The code the vendor's page showed, handed on once and kept nowhere.
    public func sendProviderSignInCode(_ providerId: String, code: String) async throws -> ProviderSignIn {
        try await providerSignIn("POST", Self.signInPath(providerId, "/sign-in/code"), json: .object(["code": .string(code), "mutationId": Self.signInMutation()]))
    }

    public func cancelProviderSignIn(_ providerId: String) async throws -> ProviderSignIn {
        try await providerSignIn("POST", Self.signInPath(providerId, "/sign-in/cancel"), json: .object(["mutationId": Self.signInMutation()]))
    }

    /// A Claude setup token, sent once and kept nowhere here; the daemon
    /// strips its whitespace.
    public func saveProviderToken(_ providerId: String, token: String) async throws -> ProviderSignIn {
        try await providerSignIn("PUT", Self.signInPath(providerId, "/token"), json: .object(["token": .string(token), "mutationId": Self.signInMutation()]))
    }
}

/// How one account's login is doing, from its `GET /v0/usage` entry (and
/// `provider.usage.updated` snapshots): whether its credential works
/// (`signIn`), when it was last used, and its login's renewal (`login`).
/// `lastUsedAt` and `login` come from newer daemons; an older one says only
/// `signIn` and when the reading was taken (`refreshedAt`).
public struct ProviderAccountHealth: Equatable, Sendable {
    /// When it was last used: never, or at a time. Nil where the daemon doesn't say.
    public enum LastUsed: Equatable, Sendable {
        case never
        case at(Date)
    }

    public struct RefreshError: Equatable, Sendable {
        /// The vendor's HTTP status, when it answered.
        public var status: Int?
        public var code: String?
        /// Renewing can't succeed again: the account needs signing in.
        public var permanent: Bool
        /// When renewing first failed in this run of failures.
        public var since: Date
        /// When it last tried.
        public var at: Date

        public init(status: Int? = nil, code: String? = nil, permanent: Bool = false, since: Date, at: Date) {
            self.status = status; self.code = code; self.permanent = permanent; self.since = since; self.at = at
        }

        /// Its code, else its HTTP status; nil when it gave neither.
        public var reason: String? { code ?? status.map { "HTTP \($0)" } }
    }

    public struct Login: Equatable, Sendable {
        public var refreshedAt: Date?
        public var expiresAt: Date?
        public var refreshError: RefreshError?

        public init(refreshedAt: Date? = nil, expiresAt: Date? = nil, refreshError: RefreshError? = nil) {
            self.refreshedAt = refreshedAt; self.expiresAt = expiresAt; self.refreshError = refreshError
        }
    }

    /// `signed_in`, `signed_out` or `unknown`.
    public var signIn: String?
    public var lastUsed: LastUsed?
    public var login: Login?
    /// When the usage reading was last taken: what an older daemon has.
    public var checkedAt: Date?
    /// The plan the vendor names ("Pro"), when it names one.
    public var planName: String?

    public init(signIn: String? = nil, lastUsed: LastUsed? = nil, login: Login? = nil, checkedAt: Date? = nil, planName: String? = nil) {
        self.signIn = signIn; self.lastUsed = lastUsed; self.login = login; self.checkedAt = checkedAt; self.planName = planName
    }

    private static func date(_ value: JSONValue?) -> Date? {
        value?.numberValue.map { Date(timeIntervalSince1970: $0 / 1000) }
    }

    public init(_ entry: JSONValue) {
        let lastUsed: LastUsed?
        switch entry["lastUsedAt"] {
        case nil: lastUsed = nil
        case .some(let value): lastUsed = Self.date(value).map(LastUsed.at) ?? .never
        }
        var login: Login?
        if let raw = entry["login"], raw.objectValue != nil {
            let error = raw["refreshError"]
            let refreshError: RefreshError? = error.flatMap { error in
                guard error.objectValue != nil, let since = Self.date(error["since"]) else { return nil }
                return RefreshError(status: error["status"]?.numberValue.map { Int($0) }, code: error["code"]?.stringValue,
                                    permanent: error["permanent"]?.boolValue ?? false, since: since, at: Self.date(error["at"]) ?? since)
            }
            login = Login(refreshedAt: Self.date(raw["refreshedAt"]), expiresAt: Self.date(raw["expiresAt"]), refreshError: refreshError)
        }
        self.init(signIn: entry["signIn"]?.stringValue, lastUsed: lastUsed, login: login,
                  checkedAt: Self.date(entry["refreshedAt"]) ?? Self.date(entry["usage"]?["capturedAt"]),
                  planName: entry["usage"]?["planName"]?.stringValue)
    }

    public static func read(usage: JSONValue) -> [String: ProviderAccountHealth] {
        var health: [String: ProviderAccountHealth] = [:]
        for entry in usage["providers"]?.arrayValue ?? [] {
            guard let id = entry["providerId"]?.stringValue else { continue }
            health[id] = ProviderAccountHealth(entry)
        }
        return health
    }
}

/// What an account's row says under its name, the first that applies:
/// off; needs signing in; couldn't renew its login; else working, with
/// when it was last used and renewed.
public enum ProviderAccountStatus: Equatable, Sendable {
    public enum Dot: Equatable, Sendable { case green, amber, red, grey }

    case off
    /// Signed out, or its login can't be renewed; since when, if known.
    case needsSignIn(since: Date?)
    /// Renewing failed and will be tried again.
    case refreshFailed(reason: String?, at: Date)
    /// `signedIn`: the daemon says it works (green), or doesn't know
    /// (grey). `used`, `refreshed` and `checked` as far as known.
    case working(signedIn: Bool, system: Bool, used: ProviderAccountHealth.LastUsed?, refreshed: Date?, checked: Date?)

    public init(enabled: Bool, source: ProviderCredential.Source, health: ProviderAccountHealth?) {
        let error = health?.login?.refreshError
        if !enabled {
            self = .off
        } else if health?.signIn == "signed_out" || error?.permanent == true {
            self = .needsSignIn(since: error?.since)
        } else if let error {
            self = .refreshFailed(reason: error.reason, at: error.at)
        } else {
            let newer = health?.lastUsed != nil || health?.login != nil
            self = .working(signedIn: health?.signIn == "signed_in", system: source == .system, used: health?.lastUsed,
                            refreshed: health?.login?.refreshedAt, checked: newer ? nil : health?.checkedAt)
        }
    }

    public var dot: Dot {
        switch self {
        case .off: .grey
        case .needsSignIn: .red
        case .refreshFailed: .amber
        case .working(let signedIn, _, _, _, _): signedIn ? .green : .grey
        }
    }

    /// When the login runs out, said on the row only while renewing it is
    /// failing and that is within a day.
    public static func expiryWarning(_ health: ProviderAccountHealth?, now: Date) -> Date? {
        guard let login = health?.login, login.refreshError != nil, let expires = login.expiresAt,
              expires.timeIntervalSince(now) < 24 * 3600 else { return nil }
        return expires
    }
}
