import Foundation

/// `GET /v0/onboarding`: what a server still wants of the person. A
/// standalone computer sends `completed` and `steps`; a Happy Cloud server
/// adds the Chief of Staff's naming (`steps.chiefOfStaff`) and splits the
/// rest into the server's (`server`) and this member's own (`member`).
/// Providers never block completion: the operator's free model lets a
/// member start without one. Every part this phone can't read is nil, not
/// a failed read.
public struct Onboarding: Decodable, Equatable, Sendable {
    public struct Step: Decodable, Equatable, Sendable {
        public var done: Bool
        public init(done: Bool) { self.done = done }
    }

    /// `signedIn`: an account connected; `readyNow`: one that can take a
    /// turn this minute, cooldowns and limits applied (Cloud only).
    public struct Providers: Decodable, Equatable, Sendable {
        public var done: Bool
        public var signedIn: Bool?
        public var readyNow: Bool?
        public init(done: Bool, signedIn: Bool? = nil, readyNow: Bool? = nil) {
            self.done = done; self.signedIn = signedIn; self.readyNow = readyNow
        }
    }

    /// `done` once its name is confirmed, not merely once it exists.
    public struct ChiefOfStaff: Decodable, Equatable, Sendable {
        public var done: Bool
        public var name: String?
        public var botId: String?
        public init(done: Bool, name: String? = nil, botId: String? = nil) {
            self.done = done; self.name = name; self.botId = botId
        }
    }

    public struct Steps: Decodable, Equatable, Sendable {
        public var providers: Providers?
        public var profile: Step?
        public var project: Step?
        public var chiefOfStaff: ChiefOfStaff?

        enum CodingKeys: String, CodingKey { case providers, profile, project, chiefOfStaff }

        public init(providers: Providers? = nil, profile: Step? = nil, project: Step? = nil, chiefOfStaff: ChiefOfStaff? = nil) {
            self.providers = providers; self.profile = profile; self.project = project; self.chiefOfStaff = chiefOfStaff
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            providers = try? container.decodeIfPresent(Providers.self, forKey: .providers)
            profile = try? container.decodeIfPresent(Step.self, forKey: .profile)
            project = try? container.decodeIfPresent(Step.self, forKey: .project)
            chiefOfStaff = try? container.decodeIfPresent(ChiefOfStaff.self, forKey: .chiefOfStaff)
        }
    }

    /// The server's part (`completed`: the Chief of Staff is named) or
    /// this member's (`completed`: their profile is saved).
    public struct Part: Decodable, Equatable, Sendable {
        public var completed: Bool
        public var steps: Steps
        public init(completed: Bool, steps: Steps = Steps()) { self.completed = completed; self.steps = steps }
    }

    public var completed: Bool
    public var steps: Steps
    public var server: Part?
    public var member: Part?

    enum CodingKeys: String, CodingKey { case completed, steps, server, member }

    public init(completed: Bool, steps: Steps = Steps(), server: Part? = nil, member: Part? = nil) {
        self.completed = completed; self.steps = steps; self.server = server; self.member = member
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        completed = (try? container.decodeIfPresent(Bool.self, forKey: .completed)) ?? false
        steps = (try? container.decodeIfPresent(Steps.self, forKey: .steps)) ?? Steps()
        server = try? container.decodeIfPresent(Part.self, forKey: .server)
        member = try? container.decodeIfPresent(Part.self, forKey: .member)
    }

    /// The events after which it is read again: the server nudges
    /// `config.updated` when the Chief of Staff is seeded or named and when
    /// onboarding completes; providers and the profile send their own.
    public static let refreshEvents = ["config.updated", "provider.", "profile."]

    /// Whether the person has yet to tell this server their name: this
    /// member's profile step, else the installation's (`profile.done`).
    /// A name in the profile decides nothing; unsaved, it is only the
    /// server's suggestion. Nil when the server reports neither.
    public var needsName: Bool? {
        (member?.steps.profile ?? steps.profile).map { !$0.done }
    }
}

extension AgentClient {
    public func onboarding() async throws -> Onboarding {
        try await decode(Onboarding.self, "GET", "/v0/onboarding")
    }
}
