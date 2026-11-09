import Foundation
import HappyWire

extension AgentWire {
    /// A team member as a Happy Cloud server describes them on their
    /// profile (`GET /v0/users/:id/profile`, happy-cluster): `TeamUser`'s
    /// name and picture, with their job title and their role on the team.
    /// The picture's bytes are at `TeamUser.photoPath`.
    public struct ProfileUser: Decodable, Equatable, Sendable {
        public var id: String
        public var name: String
        public var photo: Profile.Photo?
        /// The job title they gave themselves; free text.
        public var role: String?
        /// `owner`, `member` or a team's own role ID; nil once they left the team.
        public var teamRole: String?

        public init(id: String, name: String, photo: Profile.Photo? = nil, role: String? = nil, teamRole: String? = nil) {
            self.id = id
            self.name = name
            self.photo = photo
            self.role = role
            self.teamRole = teamRole
        }

        enum CodingKeys: String, CodingKey { case id, name, photo, role, teamRole }

        /// A field it can't read is none, never a lost profile.
        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            name = (try? container.decode(String.self, forKey: .name)) ?? ""
            photo = try? container.decodeIfPresent(Profile.Photo.self, forKey: .photo)
            role = (try? container.decodeIfPresent(String.self, forKey: .role)) ?? nil
            teamRole = (try? container.decodeIfPresent(String.self, forKey: .teamRole)) ?? nil
        }

        public var asTeamUser: TeamUser { TeamUser(id: id, name: name, photo: photo) }
    }

    /// A member's profile: who they are, what they have done, and the
    /// tasks they were last at, newest first (the same objects as
    /// `GET /v0/tasks`).
    public struct UserProfile: Decodable, Equatable, Sendable {
        public var user: ProfileUser
        public var stats: Stats
        public var recentTasks: [Task]

        public init(user: ProfileUser, stats: Stats = Stats(), recentTasks: [Task] = []) {
            self.user = user
            self.stats = stats
            self.recentTasks = recentTasks
        }

        enum CodingKeys: String, CodingKey { case user, stats, recentTasks }

        /// Stats or a task it can't read are left out; the person never is.
        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            user = try container.decode(ProfileUser.self, forKey: .user)
            stats = (try? container.decode(Stats.self, forKey: .stats)) ?? Stats()
            recentTasks = ((try? container.decode([Lossy<Task>].self, forKey: .recentTasks)) ?? []).compactMap(\.value)
        }

        public struct Stats: Decodable, Equatable, Sendable {
            public var tasks: TaskCounts
            /// When they last did anything, in epoch milliseconds.
            public var lastActivityAt: Double?
            /// UTC days with usage in the last 30.
            public var activeDays: Int
            /// Tokens by window, then provider, then model.
            public var usage: [String: [String: [String: Tokens]]]

            public init(tasks: TaskCounts = TaskCounts(), lastActivityAt: Double? = nil, activeDays: Int = 0, usage: [String: [String: [String: Tokens]]] = [:]) {
                self.tasks = tasks
                self.lastActivityAt = lastActivityAt
                self.activeDays = activeDays
                self.usage = usage
            }

            enum CodingKeys: String, CodingKey { case tasks, lastActivityAt, activeDays, usage }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                tasks = (try? container.decode(TaskCounts.self, forKey: .tasks)) ?? TaskCounts()
                lastActivityAt = (try? container.decodeIfPresent(Double.self, forKey: .lastActivityAt)) ?? nil
                activeDays = (try? container.decode(Int.self, forKey: .activeDays)) ?? 0
                // A window it can't read counts nothing; the others stand.
                usage = ((try? container.decode([String: Lossy<[String: [String: Tokens]]>].self, forKey: .usage)) ?? [:]).compactMapValues(\.value)
            }

            /// Every token of `window`, summed across providers and models,
            /// for display: input and output (`Tokens.total`).
            public func tokens(_ window: UsageWindow) -> Int {
                (usage[window.rawValue] ?? [:]).values.reduce(0) { total, models in
                    models.values.reduce(total) { $0 + $1.total }
                }
            }
        }

        public struct TaskCounts: Decodable, Equatable, Sendable {
            public var total: Int
            public var active: Int

            public init(total: Int = 0, active: Int = 0) {
                self.total = total
                self.active = active
            }
        }

        public struct Tokens: Decodable, Equatable, Sendable {
            public var input: Int
            public var cacheRead: Int
            public var cacheWrite: Int
            public var output: Int
            public var reasoning: Int

            public init(input: Int = 0, cacheRead: Int = 0, cacheWrite: Int = 0, output: Int = 0, reasoning: Int = 0) {
                self.input = input
                self.cacheRead = cacheRead
                self.cacheWrite = cacheWrite
                self.output = output
                self.reasoning = reasoning
            }

            enum CodingKeys: String, CodingKey { case input, cacheRead, cacheWrite, output, reasoning }

            /// A count it can't read is none.
            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                func count(_ key: CodingKeys) -> Int { (try? container.decode(Double.self, forKey: key)).map { Int($0) } ?? 0 }
                input = count(.input)
                cacheRead = count(.cacheRead)
                cacheWrite = count(.cacheWrite)
                output = count(.output)
                reasoning = count(.reasoning)
            }

            /// What it used, as desktop and Android count it: `input` already
            /// holds the cached tokens and `output` the reasoning ones
            /// (happy-cluster `metering.rs`), so only those two add up.
            public var total: Int { input + output }
        }
    }

    /// The windows a profile's usage is counted over, shortest first.
    public enum UsageWindow: String, CaseIterable, Sendable {
        case hour, day, week, month
    }
}

/// One of a Happy Cloud team's roles (`GET /v0/roles`): the built-in
/// owner, admin, member and viewer, or one the team made, by its name.
public struct TeamRole: Decodable, Equatable, Sendable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

extension AgentClient {
    /// The team's roles, as desktop and Android name them.
    public func teamRoles() async throws -> [TeamRole] {
        struct Response: Decodable { let roles: [Lossy<TeamRole>] }
        return try await decode(Response.self, "GET", "/v0/roles").roles.compactMap(\.value)
    }

    /// How many recent tasks a profile is read with: the server's default.
    public static let profileTaskLimit = 10

    /// `GET /v0/users/:id/profile` (Happy Cloud only): `403` with
    /// `profile_required` when the person's role can't see profiles, `404`
    /// for someone not on the team.
    public func userProfile(_ userId: String, limit: Int = AgentClient.profileTaskLimit) async throws -> AgentWire.UserProfile {
        try await decode(AgentWire.UserProfile.self, "GET", "/v0/users/\(Self.escape(userId))/profile?limit=\(min(50, max(1, limit)))")
    }
}

extension Search {
    /// Someone the computer found (a `user` result): who, and what they are called.
    public struct Person: Equatable, Sendable {
        public var userId: String
        public var name: String

        public init(userId: String, name: String) {
            self.userId = userId
            self.name = name
        }
    }

    /// How many people a query shows.
    public static let peopleLimit = 6

    /// The people among the computer's results, in its order, each once,
    /// at most `limit`. Only a Happy Cloud server finds them.
    public static func people(_ results: [Result], limit: Int = peopleLimit) -> [Person] {
        var seen: Set<String> = []
        return results.compactMap { result -> Person? in
            guard result.type == "user", let userId = result.userId, !userId.isEmpty, seen.insert(userId).inserted else { return nil }
            return Person(userId: userId, name: result.name ?? "")
        }.prefix(limit).map { $0 }
    }
}
