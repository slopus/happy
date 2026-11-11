#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
import Foundation
import HappyWire

/// The store tour's conversation: Product Health's history, and the
/// scripted answer to the question typed during the recording. Fictional.
enum StoryTour {
    static let agentId = "bot-2"

    static func json(_ text: String) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) }
    static func string(_ value: JSONValue) -> String { String(decoding: try! JSONEncoder().encode(value), as: UTF8.self) }

    static func text(_ text: String) -> JSONValue { .object(["type": .string("text"), "text": .string(text)]) }
    static let chart = json("""
    {"type":"tool_call","id":"tour-chart","name":"create_artifact","status":"completed","presentation":{"type":"artifact","artifactId":"retention","artifactType":"html","title":"Weekly retention","version":1,"shows":"latest"}}
    """)

    static func message(_ id: String, _ role: String, at: Double, user: String? = nil, _ content: JSONValue) -> JSONValue {
        .object([
            "id": .string(id), "role": .string(role), "createdAt": .number(at),
            "metadata": .object(user.map { ["userId": .string($0)] } ?? [:]), "content": .array([content]),
        ])
    }

    static func bootstrap(now: Double) -> String {
        string(.object([
            "agent": .object([
                "id": .string(agentId), "workspaceId": .string(agentId), "title": .string("Product Health"), "status": .string("idle"),
                "version": .string("1"), "createdAt": .number(now - 3_600_000), "updatedAt": .number(now - 60_000),
            ]),
            "mode": .object(["providerId": .string("claude-personal"), "modelId": .string("claude/m0"), "effort": .string("medium"), "permissionMode": .string("auto")]),
            "draft": .object(["value": .null, "updatedAt": .null]),
            "pending": .array([]),
        ]))
    }

    /// The personal MacBook's Home: a few things of one person's own.
    static func personalHome(now: Double) -> String {
        func agent(_ id: String, _ title: String, _ status: String = "idle") -> JSONValue {
            .object(["id": .string(id), "workspaceId": .string(id), "title": .string(title), "status": .string(status), "version": .string("1"),
                     "createdAt": .number(now - 7_200_000), "updatedAt": .number(now - 600_000)])
        }
        func task(_ id: String, _ name: String, _ status: String = "idle") -> JSONValue {
            .object(["id": .string(id), "name": .string(name), "ownerUserId": .string("kirill"), "status": .string("active"),
                     "agent": agent(id, name, status), "version": .string("1")])
        }
        let tasks = [task("p-1", "Lisbon Trip Plan"), task("p-2", "Home Server Backups", "working"), task("p-3", "Dotfiles Cleanup")]
        return string(.object([
            "cursor": .string("story-1"), "feedUnread": .number(0),
            "profile": .object(["userId": .string("kirill"), "photo": .object(["thumbhash": .string("1QcSHQRnh493V4dIh4eXh1h4kJUI")])]),
            "userSettings": .array([]),
            "projects": .array([.object(["id": .string("dotfiles"), "name": .string("dotfiles"), "status": .string("active"), "version": .string("1"),
                                         "orderKey": .string("1"), "agents": .array([])])]),
            "workspaces": .array([]),
            "bots": .array([.object(["id": .string("p-bot"), "name": .string("Morning Briefing"), "status": .string("active"),
                                     "agent": agent("p-bot", "Morning Briefing"), "systemKey": .null, "version": .string("1")])]),
            "tasks": .array(tasks),
            "taskMemberships": .array(["p-1", "p-2", "p-3"].map { .object(["taskId": .string($0)]) }),
            "surfaces": .array([]),
        ]))
    }

    /// Two earlier exchanges, the last a few minutes ago.
    static func history(now: Double) -> [JSONValue] {
        let pairs = [
            ("What's left before release?", "Sync benchmarks and store screenshots. Both are on the 2.0 checklist."),
            ("Are the mobile builds ready?", "Yes. Android push fixes and the iOS overlay fix are checked off."),
        ]
        return pairs.enumerated().map { index, pair in
            let at = now - Double(pairs.count - index) * 1_800_000
            return .object([
                "id": .string("tour-run-\(index)"), "status": .string("completed"), "startedAt": .number(at), "endedAt": .number(at + 20_000),
                "reason": .string("completed"), "messages": .array([
                    message("tour-\(index)-u", "user", at: at, user: "kirill", text(pair.0)),
                    message("tour-\(index)-a", "agent", at: at + 20_000, text(pair.1)),
                ]),
            ])
        }
    }
}
#endif
