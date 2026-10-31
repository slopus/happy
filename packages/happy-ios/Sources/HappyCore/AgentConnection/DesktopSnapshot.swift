import Foundation
import HappyWire

/// The public daemon setting object, including null tombstones and its
/// monotonic UUIDv7 version. An offline edit retains its original timestamp.
public struct UserSetting: Codable, Equatable, Sendable {
    public var key: String
    public var value: JSONValue
    public var updatedAt: Double?
    public var version: String?
}

/// GET /v0/bootstrap/desktop, shared with desktop. Extra fields remain on the
/// wire; these are the explicitly typed fields the phone actually renders.
public struct DesktopSnapshot: Codable, Equatable, Sendable {
    public struct Project: Codable, Equatable, Sendable {
        public var id: String
        public var name: String
        public var status: String
        public var orderKey: String
        public var agents: [AgentWire.Agent]
        /// The project's picture: one the person chose or the daemon made
        /// (`{ kind: "image", source, thumbhash }`, read at
        /// `/v0/projects/<id>/avatar`), the home project's house
        /// (`{ kind: "home" }`), or nil while it has none yet. One it can't
        /// read is none.
        public var avatar: Avatar?

        public struct Avatar: Codable, Equatable, Sendable {
            /// "image" or "home"; nil from a daemon that sent `url` instead.
            public var kind: String?
            public var thumbhash: String?
            /// Daemon-relative, read with the same bearer token: an older
            /// daemon's only way of saying where the picture is.
            public var url: String?

            public init(kind: String? = nil, thumbhash: String? = nil, url: String? = nil) {
                self.kind = kind
                self.thumbhash = thumbhash
                self.url = url
            }
        }

        enum CodingKeys: String, CodingKey { case id, name, status, orderKey, agents, avatar }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            name = try container.decode(String.self, forKey: .name)
            status = try container.decode(String.self, forKey: .status)
            orderKey = try container.decode(String.self, forKey: .orderKey)
            agents = try container.decode([AgentWire.Agent].self, forKey: .agents)
            avatar = try? container.decodeIfPresent(Avatar.self, forKey: .avatar)
        }
    }
    public struct Workspace: Codable, Equatable, Sendable {
        public var id: String
        public var projectId: String?
        public var parentId: String?
        public var name: String
        public var kind: String
        public var status: String
        public var orderKey: String
        public var agents: [AgentWire.Agent]
    }
    public struct Owner: Codable, Equatable, Sendable {
        public var id: String
        public var name: String?
        public var status: String?
        public var systemKey: String?
        public var agent: AgentWire.Agent?
        public var avatar: AgentWire.Avatar?
        public var canArchive: Bool?
        /// A task's: the team member it belongs to, who made it; nil on a
        /// standalone computer, for a bot, or when nobody was identified.
        public var ownerUserId: String?
    }
    public struct Membership: Codable, Equatable, Sendable {
        public var taskId: String
    }
    /// The person signed in: their team user (nil outside a team) and
    /// their picture's ThumbHash.
    public struct Profile: Codable, Equatable, Sendable {
        public var userId: String?
        public var photo: AgentWire.Profile.Photo?

        public init(userId: String? = nil, photo: AgentWire.Profile.Photo? = nil) {
            self.userId = userId
            self.photo = photo
        }

        enum CodingKeys: String, CodingKey { case userId, photo }

        /// A picture it can't read is none, never a lost bootstrap.
        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            userId = try container.decodeIfPresent(String.self, forKey: .userId)
            photo = try? container.decodeIfPresent(AgentWire.Profile.Photo.self, forKey: .photo)
        }
    }
    public struct Surface: Codable, Equatable, Sendable {
        public struct Member: Codable, Equatable, Sendable {
            public var userId: String?
            public var orderKey: String
        }
        public var id: String
        public var name: String
        public var type: String
        public var members: [Member]
        public var chatAgentId: String?
    }

    public var projects: [Project]
    public var workspaces: [Workspace]
    public var bots: [Owner]?
    public var tasks: [Owner]?
    public var taskMemberships: [Membership]?
    public var surfaces: [Surface]?
    public var profile: Profile?
    public var userSettings: [UserSetting]?
    public var cursor: String
}

public enum DesktopSettingKeys {
    public static let projectsVisibility = "happy-desktop.projectsVisibility"

    public static func projectsHidden(_ values: [String: JSONValue]) -> Bool {
        values[projectsVisibility]?["projectsHidden"] == .bool(true)
    }
}