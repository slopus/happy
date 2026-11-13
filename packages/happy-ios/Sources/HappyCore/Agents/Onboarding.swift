import Foundation
import HappyWire

/// `GET /v0/onboarding` on a Happy Cloud server: the gates it holds the
/// person to, in the order the flow shows them. Gates are read live and
/// nothing latches: a gate made required later blocks again, and
/// `finished` turns false.
public struct Onboarding: Decodable, Equatable, Sendable {
    /// The server's `finished`: no gate blocks the person, and no optional
    /// one is still open for them to take. A server from before it sends
    /// `completed` alone, which meant the same then; since, `completed`
    /// stays true with optional gates open, for shipped clients.
    public var finished: Bool
    /// The IDs of the gates that block the person.
    public var blocking: [String]
    public var gates: [OnboardingGate]

    public init(finished: Bool, blocking: [String] = [], gates: [OnboardingGate] = []) {
        self.finished = finished; self.blocking = blocking; self.gates = gates
    }

    /// Read from a server without gates (`Legacy`): the flow only asks the
    /// name, and never finishes onboarding (`completeOnboarding`).
    public var legacy = false

    enum CodingKeys: String, CodingKey { case finished, completed, blocking, gates }

    /// A gate that can't be read is kept as `.unknown`, so a blocking one
    /// still holds the person (Update Happy) rather than vanishing.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard c.contains(.gates) else { self = try Legacy(from: decoder).onboarding; return }
        finished = (try? c.decodeIfPresent(Bool.self, forKey: .finished)) ?? (try? c.decodeIfPresent(Bool.self, forKey: .completed)) ?? false
        blocking = (try? c.decodeIfPresent([String].self, forKey: .blocking)) ?? []
        gates = ((try? c.decodeIfPresent([Lossy<OnboardingGate>].self, forKey: .gates)) ?? []).compactMap(\.value)
    }

    // MARK: Legacy: delete once happy-cluster serves gates everywhere

    /// A server from before gates (`steps`, `member.steps`): only whether
    /// the person still has to give their name, the member's step over the
    /// installation's, read as one required profile gate. Neither says,
    /// and nothing is asked.
    struct Legacy: Decodable {
        struct Done: Decodable { var done: Bool }
        struct Steps: Decodable { var profile: Done? }
        struct Part: Decodable { var steps: Steps? }
        var steps: Steps?
        var member: Part?

        var onboarding: Onboarding {
            let needsName = (member?.steps?.profile ?? steps?.profile).map { !$0.done } ?? false
            var onboarding = needsName
                ? Onboarding(finished: false, blocking: ["profile"], gates: [OnboardingGate(id: "profile", requirement: .required, kind: .profile)])
                : Onboarding(finished: true)
            onboarding.legacy = true
            return onboarding
        }

        init(from decoder: Decoder) throws {
            enum Keys: String, CodingKey { case steps, member }
            let c = try decoder.container(keyedBy: Keys.self)
            steps = try? c.decodeIfPresent(Steps.self, forKey: .steps)
            member = try? c.decodeIfPresent(Part.self, forKey: .member)
        }
    }

    public func gate(_ id: String) -> OnboardingGate? { gates.first { $0.id == id } }

    /// The events after which it is read again; the app coming back to the
    /// foreground reads it too (a sign-in on another phone sends nothing).
    public static let refreshEvents = [
        "onboarding.updated", "profile.updated", "bot.updated", "config.updated", "plugins.changed",
        "invite.created", "member.updated", "member.removed",
    ]
}

/// One step the server holds the person to.
public struct OnboardingGate: Decodable, Equatable, Sendable {
    public enum Scope: String, Sendable { case member, server }
    public enum Requirement: String, Sendable { case optional, required }
    public enum Status: String, Sendable { case done, open, skipped, unavailable }

    /// What the gate asks, with what its screen needs. `unknown`: a gate
    /// this app can't show (a newer one, or one it couldn't read).
    public enum Kind: Equatable, Sendable {
        case profile
        case avatar
        case adminBot(AdminBot)
        case inference(Inference)
        case plugins(Plugins)
        case teammates(Teammates)
        case mobileApp(MobileApp)
        case paymentMethod
        case payment
        case unknown
    }

    /// The Chief of Staff, and the words the server explains it with.
    /// `version` goes in `If-Match` when it is renamed.
    public struct AdminBot: Decodable, Equatable, Sendable {
        public var botId: String
        public var agentId: String?
        public var name: String
        public var version: String?
        public var avatar: Avatar?
        public var title: String?
        public var description: String?
        /// Short lines on what it can do, and a closing note.
        public var points: [String]?
        public var note: String?

        public struct Avatar: Decodable, Equatable, Sendable {
            public var digest: String
            public var mime: String?
            public var thumbhash: String?
        }
    }

    /// `connected`: the team's or the person's own providers;
    /// `freeModel`: whether the operator's free model runs meanwhile.
    public struct Inference: Decodable, Equatable, Sendable {
        public var connected: [String]
        public var freeModel: Bool

        enum CodingKeys: String, CodingKey { case connected, freeModel }
        public init(connected: [String] = [], freeModel: Bool = false) { self.connected = connected; self.freeModel = freeModel }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            connected = ((try? c.decodeIfPresent([Lossy<String>].self, forKey: .connected)) ?? []).compactMap(\.value)
            freeModel = (try? c.decodeIfPresent(Bool.self, forKey: .freeModel)) ?? false
        }
    }

    /// The plugins the server asks for; with none required, any one
    /// active completes the gate.
    public struct Plugins: Decodable, Equatable, Sendable {
        public struct Plugin: Decodable, Equatable, Sendable {
            public var id: String
            public var name: String
            public var required: Bool
            public var active: Bool
        }
        public var required: [String]
        public var plugins: [Plugin]

        enum CodingKeys: String, CodingKey { case required, plugins }
        public init(required: [String] = [], plugins: [Plugin] = []) { self.required = required; self.plugins = plugins }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            required = (try? c.decodeIfPresent([String].self, forKey: .required)) ?? []
            plugins = ((try? c.decodeIfPresent([Lossy<Plugin>].self, forKey: .plugins)) ?? []).compactMap(\.value)
        }

        /// The gate's screen: the required plugins first, in the server's
        /// order, then every other plugin `catalog` offers; each active
        /// as the catalog's installations say, else as the gate did.
        public func rows(_ catalog: PluginCatalog?) -> [Plugin] {
            let needed = plugins.filter(\.required)
            let rest = catalog.map { catalog in catalog.plugins.map { Plugin(id: $0.id, name: $0.name, required: false, active: false) } } ?? plugins
            return (needed + rest.filter { plugin in !needed.contains { $0.id == plugin.id } }).map { plugin in
                var plugin = plugin
                if let installations = catalog?.installations {
                    plugin.active = installations.contains { $0.pluginId == plugin.id && $0.status == .active }
                }
                return plugin
            }
        }
    }

    public struct Teammates: Decodable, Equatable, Sendable {
        public var invited: Bool
        public var members: Int

        enum CodingKeys: String, CodingKey { case invited, members }
        public init(invited: Bool = false, members: Int = 1) { self.invited = invited; self.members = members }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            invited = (try? c.decodeIfPresent(Bool.self, forKey: .invited)) ?? false
            members = (try? c.decodeIfPresent(Int.self, forKey: .members)) ?? 1
        }
    }

    /// `registered`: this person has a live push registration from a phone.
    public struct MobileApp: Decodable, Equatable, Sendable {
        public var registered: Bool
        public var appStoreUrl: String?
        public var playStoreUrl: String?
    }

    public var id: String
    public var scope: Scope
    public var requirement: Requirement
    public var status: Status
    /// The server's: required, and open or not yet able to be told.
    public var blocking: Bool
    /// Whether the person's role lets them complete it.
    public var canComplete: Bool
    public var kind: Kind

    public init(id: String, scope: Scope = .member, requirement: Requirement = .optional, status: Status = .open,
                blocking: Bool? = nil, canComplete: Bool = true, kind: Kind) {
        self.id = id; self.scope = scope; self.requirement = requirement; self.status = status
        self.blocking = blocking ?? (requirement == .required && (status == .open || status == .unavailable))
        self.canComplete = canComplete; self.kind = kind
    }

    enum CodingKeys: String, CodingKey { case id, scope, requirement, status, blocking, canComplete, data }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        blocking = (try? c.decodeIfPresent(Bool.self, forKey: .blocking)) ?? false
        canComplete = (try? c.decodeIfPresent(Bool.self, forKey: .canComplete)) ?? false
        let scope = (try? c.decodeIfPresent(String.self, forKey: .scope)).flatMap { $0.flatMap(Scope.init(rawValue:)) }
        let requirement = (try? c.decodeIfPresent(String.self, forKey: .requirement)).flatMap { $0.flatMap(Requirement.init(rawValue:)) }
        let status = (try? c.decodeIfPresent(String.self, forKey: .status)).flatMap { $0.flatMap(Status.init(rawValue:)) }
        self.scope = scope ?? .server
        self.requirement = requirement ?? (blocking ? .required : .optional)
        self.status = status ?? (blocking ? .open : .unavailable)
        // A gate whose words this app doesn't know, or whose data it can't
        // read, is one it can't show.
        guard scope != nil, requirement != nil, status != nil else { kind = .unknown; return }
        func data<T: Decodable>(_ type: T.Type) -> T? { try? c.decode(T.self, forKey: .data) }
        kind = switch id {
        case "profile": .profile
        case "avatar": .avatar
        case "adminBot": data(AdminBot.self).map(Kind.adminBot) ?? .unknown
        case "inference": .inference(data(Inference.self) ?? Inference())
        case "plugins": .plugins(data(Plugins.self) ?? Plugins())
        case "teammates": .teammates(data(Teammates.self) ?? Teammates())
        case "mobileApp": data(MobileApp.self).map(Kind.mobileApp) ?? .unknown
        case "paymentMethod": .paymentMethod
        case "payment": .payment
        default: .unknown
        }
    }

    /// Still the person's to see to: it blocks them, or it is an optional
    /// step they can take and have neither taken nor skipped.
    public var isPending: Bool {
        blocking || (requirement == .optional && status == .open && canComplete)
    }
}

/// `POST /v0/onboarding/complete` refused: these gates still block.
public struct OnboardingIncomplete: Error, Equatable, Sendable {
    public var blocking: [String]
}

extension AgentClient {
    public func onboarding() async throws -> Onboarding {
        try await decode(Onboarding.self, "GET", "/v0/onboarding")
    }

    /// Skips an optional gate: for the person alone (a member gate) or the
    /// whole team (a server gate). Answers what onboarding is now.
    public func skipOnboardingGate(_ id: String) async throws -> Onboarding {
        try await decode(Onboarding.self, "POST", "/v0/onboarding/gates/\(Self.escape(id))/skip", json: .object([:]))
    }

    /// Finishes onboarding, skipping every optional gate still open that the
    /// person can complete. Throws `OnboardingIncomplete` while a gate blocks.
    public func completeOnboarding() async throws {
        let body = try JSONEncoder().encode(JSONValue.object([:]))
        let response = try await transport.request(method: "POST", path: "/v0/onboarding/complete", credential: token, body: body, headers: [:], category: .query)
        if response.status == 401 { throw AgentClientError.revoked }
        if response.status == 409, let body = try? JSONValue.decode(response.body), body["code"]?.stringValue == "onboarding_incomplete" {
            throw OnboardingIncomplete(blocking: body["blocking"]?.arrayValue?.compactMap(\.stringValue) ?? [])
        }
        _ = try Self.checked(response)
    }
}
