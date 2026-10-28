import Foundation
import HappyWire

/// The public daemon setting object, including null tombstones and its
/// monotonic UUIDv7 version. An offline edit retains its original timestamp.
public struct DirectUserSetting: Codable, Equatable, Sendable {
    public var key: String
    public var value: JSONValue
    public var updatedAt: Double?
    public var version: String?
}

/// GET /v0/bootstrap/desktop, shared with desktop. Extra fields remain on the
/// wire; these are the explicitly typed fields the phone actually renders.
public struct DirectDesktopSnapshot: Codable, Equatable, Sendable {
    public struct Project: Codable, Equatable, Sendable {
        public var id: String
        public var name: String
        public var status: String
        public var orderKey: String
        public var agents: [AgentWire.Agent]
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
    }
    public struct Membership: Codable, Equatable, Sendable {
        public var taskId: String
    }
    public struct Profile: Codable, Equatable, Sendable { public var userId: String? }
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
    public var userSettings: [DirectUserSetting]?
    public var cursor: String
}

public enum DirectSettings {
    public static let projectsVisibility = "happy-desktop.projectsVisibility"
    public static let stemCells = "happy-desktop.experiments.stemCells"

    public static func projectsHidden(_ values: [String: JSONValue]) -> Bool {
        values[projectsVisibility]?["projectsHidden"] == .bool(true)
    }
}