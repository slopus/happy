import Foundation
import HappyWire

/// Chat UI (happy-agent `API.md`, "Chat UI", protocol 35): a document, a
/// flat list of typed components, in a `ui` block of a message the daemon
/// wrote or a `ui` presentation of a `show_ui` call. Every press is one
/// silent `POST /v0/agents/:agentId/actions`; suggested replies are not
/// components but `QuickReplies`, sent as ordinary words. The rules here are
/// `@slopus/happy-agent-client`'s `sources/ui`, checked against its
/// `fixtures/ui` (`ChatUiTests`).
public enum ChatUi {
    /// The protocol that carries chat UI. Below it, or without the header,
    /// the daemon sends each document as its fallback text.
    public static let protocolVersion = 35
    public static let protocolHeader = "Happy-Protocol"

    /// The components the phone draws itself are `images`, `file_tree`
    /// and the `live` ones, as a card of the server's state (`UiCard`);
    /// every other one shows its fallback line, and `hidden` ones nothing
    /// (the phone app's download codes and pairing, on the phone).
    public static let live: Set<String> = ["provider_sign_in", "default_model", "invite", "github_connect", "compute_join"]
    public static let hidden: Set<String> = ["phone_app", "phone_pair"]

    /// `uiDocumentFallback`: each fallback line, blank ones left out.
    public static func fallback(_ document: UiDocument) -> String {
        document.components.map { $0.fallback.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
}

public struct UiDocument: Equatable, Sendable, Codable {
    public var id: String
    public var components: [UiComponent]

    public init(id: String, components: [UiComponent]) {
        self.id = id
        self.components = components
    }
}

/// One component as sent: a type this build may not know is kept, and
/// drawn as its fallback.
public struct UiComponent: Equatable, Sendable, Codable {
    public var id: String
    public var type: String
    public var fallback: String
    public var props: JSONValue

    public init(id: String, type: String, fallback: String, props: JSONValue) {
        self.id = id
        self.type = type
        self.fallback = fallback
        self.props = props
    }

    enum CodingKeys: String, CodingKey { case id, type, fallback, props }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        type = try container.decode(String.self, forKey: .type)
        fallback = (try? container.decodeIfPresent(String.self, forKey: .fallback)) ?? ""
        props = (try? container.decodeIfPresent(JSONValue.self, forKey: .props)) ?? .object([:])
    }
}

/// `{ type: "<component>.<action>", payload }`.
public struct UiAction: Equatable, Sendable, Codable {
    public var type: String
    public var payload: JSONValue

    public init(type: String, payload: JSONValue) {
        self.type = type
        self.payload = payload
    }

    /// The component type it belongs to.
    public var componentType: String { String(type.prefix { $0 != "." }) }
}

public struct UiOutcome: Equatable, Sendable, Codable {
    /// `pending`, `accepted`, `rejected` or `failed`.
    public var status: String
    public var code: String?
    public var reason: String?

    public init(status: String, code: String? = nil, reason: String? = nil) {
        self.status = status
        self.code = code
        self.reason = reason
    }
}

/// An `action` block, in an attempt record (a service message). Its
/// payload has no secret.
public struct UiActionBlock: Equatable, Sendable, Codable {
    public var messageId: String
    public var uiId: String
    public var componentId: String
    public var action: UiAction
    public var outcome: UiOutcome

    public init(messageId: String, uiId: String, componentId: String, action: UiAction, outcome: UiOutcome) {
        self.messageId = messageId
        self.uiId = uiId
        self.componentId = componentId
        self.action = action
        self.outcome = outcome
    }

    public var offer: UiOffer { UiOffer(messageId: messageId, uiId: uiId, componentId: componentId) }
}

/// Where a component is: the agent message holding its document, the
/// document and the component.
public struct UiOffer: Hashable, Sendable {
    public var messageId: String
    public var uiId: String
    public var componentId: String

    public init(messageId: String, uiId: String, componentId: String) {
        self.messageId = messageId
        self.uiId = uiId
        self.componentId = componentId
    }

    public var key: String { "\(messageId)/\(uiId)/\(componentId)" }
}

/// What an action needs the clicking person to hold (`UiPermission`).
public enum UiPermission: Equatable, Sendable {
    case id(String)
    /// Chosen by one prop of the offer, with a default.
    case byProp(prop: String, map: [String: String], default: String)
    /// Only that the person can read the conversation.
    case conversationRead
}

/// One action of a bundle, every one silent: what it needs.
public struct UiActionDefinition: Equatable, Sendable {
    public var permission: UiPermission

    public init(permission: UiPermission = .id("content.write")) {
        self.permission = permission
    }
}

/// Catalog v1's actions and the shared functions over them.
public enum UiCatalog {
    public static let version = 1

    private static let byTarget = UiPermission.byProp(prop: "target", map: ["team": "providers.manage", "private": "providers.own"], default: "providers.own")
    private static func silent(_ permission: UiPermission) -> UiActionDefinition { UiActionDefinition(permission: permission) }

    /// Every action, by `<component>.<action>`, as `ui.schema.json` declares it.
    public static let actions: [String: UiActionDefinition] = [
        "provider_sign_in.install": silent(.id("providers.manage")),
        "provider_sign_in.sign_in": silent(byTarget),
        "provider_sign_in.submit_code": silent(byTarget),
        "provider_sign_in.submit_token": silent(byTarget),
        "provider_sign_in.cancel": silent(byTarget),
        "default_model.set": silent(.id("config.manage")),
        "phone_pair.start": silent(.id("config.manage")),
        "phone_pair.confirm": silent(.id("config.manage")),
        "phone_pair.cancel": silent(.id("config.manage")),
        "invite.create": silent(.id("members.manage")),
        "invite.revoke": silent(.id("members.manage")),
        "github_connect.install": silent(.id("repositories.manage")),
        "github_connect.device_start": silent(.conversationRead),
        "github_connect.connect": silent(.id("repositories.manage")),
        "compute_join.create": silent(.id("pools.manage")),
    ]

    /// The payload fields `ui.schema.json` marks secret: a press keeps them
    /// only for its request.
    public static let secrets: [String: Set<String>] = [
        "provider_sign_in.submit_code": ["code"],
        "provider_sign_in.submit_token": ["token"],
    ]

    /// The action without its secret fields, as a record holds it.
    public static func redacted(_ action: UiAction) -> UiAction {
        guard let fields = secrets[action.type], let object = action.payload.objectValue else { return action }
        return UiAction(type: action.type, payload: .object(object.filter { !fields.contains($0.key) }))
    }

    /// `uiActionPermission`: the permission ID it needs against the offer's
    /// props, or nil when reading the conversation is enough.
    public static func permission(_ definition: UiActionDefinition, props: JSONValue) -> String? {
        switch definition.permission {
        case .id(let id): return id
        case .conversationRead: return nil
        case .byProp(let prop, let map, let fallback):
            return props[prop]?.stringValue.flatMap { map[$0] } ?? fallback
        }
    }

    /// `uiActionAllowed`, for drawing only: the server decides. `granted`
    /// nil holds every permission (a computer of one's own).
    public static func allowed(_ actionType: String, props: JSONValue, granted: Set<String>?) -> Bool {
        guard let definition = actions[actionType] else { return false }
        guard let needed = permission(definition, props: props), let granted else { return true }
        return granted.contains(needed)
    }
}

/// A `file_tree`'s paths as the rows of a tree: each folder once, before
/// what is in it, in the order its paths first came.
public enum UiFileTree {
    public struct Row: Equatable, Sendable {
        public var depth: Int
        public var name: String
        public var folder: Bool

        public init(depth: Int, name: String, folder: Bool) {
            self.depth = depth
            self.name = name
            self.folder = folder
        }
    }

    public static func rows(_ paths: [String]) -> [Row] {
        final class Node {
            var children: [(name: String, node: Node)] = []
            var folder = false
            func child(_ name: String) -> Node {
                if let found = children.first(where: { $0.name == name }) { return found.node }
                let node = Node()
                children.append((name, node))
                return node
            }
        }
        let root = Node()
        for path in paths {
            let parts = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
            var node = root
            for (index, part) in parts.enumerated() {
                node = node.child(part)
                if index < parts.count - 1 || path.hasSuffix("/") { node.folder = true }
            }
        }
        var rows: [Row] = []
        func walk(_ node: Node, depth: Int) {
            for (name, child) in node.children {
                rows.append(Row(depth: depth, name: name, folder: child.folder || !child.children.isEmpty))
                walk(child, depth: depth + 1)
            }
        }
        walk(root, depth: 0)
        return rows
    }
}

/// One component as a conversation draws it: what it is, read from its
/// props, and how its offer stands.
public struct UiShown: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case fileTree([UiFileTree.Row])
        /// Drawn from the server's state, as a `UiCard`.
        case live
        /// A line of plain text: a component the phone doesn't draw, by its
        /// fallback, or an `images` component's captions.
        case line(String)
    }

    /// How it stands, from its attempt records and a press on this phone
    /// still on its way: its latest action.
    public struct State: Equatable, Sendable {
        public var attempt: UiAttempt?

        public init(attempt: UiAttempt? = nil) {
            self.attempt = attempt
        }
    }

    public var offer: UiOffer
    public var type: String
    /// As stored, which an action's words and permission are read against.
    public var props: JSONValue
    public var kind: Kind
    public var fallback: String
    public var state = State()
    /// The server's state a live component draws.
    public var live: UiLive?
    /// A live action's result, held by the screen that asked, secrets
    /// included, and dropped when it goes away.
    public var result: JSONValue?

    public init(offer: UiOffer, type: String, props: JSONValue, kind: Kind, fallback: String = "", state: State = State()) {
        self.offer = offer
        self.type = type
        self.props = props
        self.kind = kind
        self.fallback = fallback
        self.state = state
    }

    /// The pieces a document's component draws as: its own, an `images`
    /// grid of `media` (a `show_ui` call's items) with its captions, its
    /// fallback line, or nothing.
    public static func pieces(_ component: UiComponent, document: String, message: String, media: [Media]) -> [ChatItem.Piece] {
        let offer = UiOffer(messageId: message, uiId: document, componentId: component.id)
        let props = component.props
        func line(_ text: String) -> [ChatItem.Piece] {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? [] : [.ui(UiShown(offer: offer, type: component.type, props: props, kind: .line(trimmed)))]
        }
        if ChatUi.hidden.contains(component.type) { return [] }
        let kind: Kind?
        switch component.type {
        case "images":
            let entries = props["images"]?.arrayValue ?? []
            let shown = entries.compactMap { entry -> (Media, String?)? in
                guard let index = entry["mediaIndex"]?.numberValue.map(Int.init), media.indices.contains(index), media[index].isVisual else { return nil }
                return (media[index], entry["caption"]?.stringValue)
            }
            guard !shown.isEmpty, shown.count == entries.count else { return line(component.fallback) }
            let columns = props["columns"]?.numberValue.map(Int.init).flatMap { (1...3).contains($0) ? $0 : nil } ?? 0
            return [.gallery(shown.map(\.0), columns: columns)] + line(shown.compactMap(\.1).joined(separator: "\n"))
        case "file_tree":
            let paths = (props["paths"]?.arrayValue ?? []).compactMap(\.stringValue)
            kind = paths.isEmpty ? nil : .fileTree(UiFileTree.rows(paths))
        case "provider_sign_in":
            kind = props["provider"]?.stringValue == nil ? nil : .live
        case _ where ChatUi.live.contains(component.type):
            kind = .live
        default:
            kind = nil
        }
        guard let kind else { return line(component.fallback) }
        return [.ui(UiShown(offer: offer, type: component.type, props: props, kind: kind, fallback: component.fallback))]
    }
}

/// Suggested replies (happy-agent `API.md`, "Quick replies"): not
/// components but words the person may send, drawn under the turn that
/// suggested them for good, the one sent marked. A tap is an ordinary send
/// of the option, naming where it came from (`QuickReply`). They come in a
/// daemon-written `quick_replies` block, or the `quick_replies`
/// presentation of a `suggest_replies` call.
public struct QuickReplies: Equatable, Sendable {
    public static let max = 6

    /// The agent message holding them.
    public var messageId: String
    /// The `suggest_replies` call, for a presentation's.
    public var toolCallId: String?
    public var options: [String]
    /// The option a person's message sent, by its `quickReply`.
    public var chosen: Int?
    /// It takes a tap: the newest suggestion, nobody having written since.
    public var live: Bool

    public init(messageId: String, toolCallId: String? = nil, options: [String], chosen: Int? = nil, live: Bool = false) {
        self.messageId = messageId
        self.toolCallId = toolCallId
        self.options = options
        self.chosen = chosen
        self.live = live
    }

    /// Which suggestion a `quickReply` names.
    public func names(_ reply: QuickReply) -> Bool { reply.messageId == messageId && reply.toolCallId == toolCallId }

    /// Where option `index` came from, as `send` names it.
    public func reply(_ index: Int) -> QuickReply { QuickReply(messageId: messageId, toolCallId: toolCallId, index: index) }

    /// `normalizeQuickReply`: whitespace runs (JavaScript's `\s`) to one
    /// space, trimmed.
    public static func normalize(_ option: String) -> String {
        var out = String.UnicodeScalarView()
        var gap = false
        for scalar in option.unicodeScalars {
            if space.contains(scalar.value) { gap = !out.isEmpty; continue }
            if gap { out.append(" ") }
            gap = false
            out.append(scalar)
        }
        return String(out)
    }

    /// `quickRepliesProblems`, over options already normalized.
    public static func problems(_ options: [String]) -> [String] {
        var problems: [String] = []
        if options.isEmpty || options.count > max { problems.append("Suggest 1 to \(max) replies.") }
        for (index, option) in options.enumerated() where !(1...200).contains(option.utf16.count) || option.unicodeScalars.contains(where: { forbidden($0.value) }) {
            problems.append("Reply \(index + 1) must be plain text of 1 to 200 characters on one line.")
        }
        if let repeated = options.enumerated().first(where: { options.firstIndex(of: $0.element) != $0.offset })?.element {
            problems.append("Replies must be unique; \"\(repeated)\" repeats.")
        }
        return problems
    }

    /// What JavaScript's `\s` matches.
    private static let space: Set<UInt32> = Set([0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF] + Array(0x2000...0x200A))

    /// No C0/C1 control, DEL, or bidirectional formatting character.
    private static func forbidden(_ value: UInt32) -> Bool {
        value <= 0x1F || (0x7F...0x9F).contains(value) || value == 0x61C || value == 0x200E || value == 0x200F
            || (0x202A...0x202E).contains(value) || (0x2066...0x2069).contains(value)
    }
}

/// Where a sent message's words came from: option `index` of the
/// suggestion in agent message `messageId`, in its `suggest_replies` call
/// `toolCallId` when it has one. Set by the daemon on the stored message.
public struct QuickReply: Equatable, Sendable, Codable {
    public var messageId: String
    public var toolCallId: String?
    public var index: Int

    public init(messageId: String, toolCallId: String? = nil, index: Int) {
        self.messageId = messageId
        self.toolCallId = toolCallId
        self.index = index
    }
}
