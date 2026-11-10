import Foundation
import HappyWire

/// Chat UI (happy-agent `API.md`, "Chat UI", protocol 35): a document, a
/// flat list of typed components, in a `ui` block of a message the daemon
/// wrote or the `ui` presentation of a `show_ui` call. The phone draws
/// `file_tree`, `media` and `default_model`; every other type, and one of
/// these whose props don't fit, is its fallback line. Every press is one
/// silent `POST /v0/agents/:agentId/actions`. Suggested replies are not
/// components but `QuickReplies`, sent as ordinary words. The contract is
/// `@slopus/happy-agent-client`'s, vendored for the tests
/// (`scripts/vendor-chat-ui.mjs`, `ChatUiContractTests`).
public enum ChatUi {
    /// The protocol that carries chat UI. Below it, or without the header,
    /// the daemon sends each document as its fallback text and no attempt
    /// records.
    public static let protocolVersion = 35
    public static let protocolHeader = "Happy-Protocol"
}

public struct UiDocument: Equatable, Sendable, Codable {
    public var id: String
    public var components: [UiComponent]

    public init(id: String, components: [UiComponent]) {
        self.id = id
        self.components = components
    }
}

/// One component as sent: any type, with any props.
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

/// A presentation's `ui` when it is a document (a `show_ui` call's); a
/// `quick_replies` presentation's `ui` is a list the phone doesn't read,
/// and keeps as an empty one.
public struct PresentedUi: Equatable, Sendable, Codable {
    public var document: UiDocument?

    public init(_ document: UiDocument?) {
        self.document = document
    }

    public init(from decoder: Decoder) throws {
        document = try? decoder.singleValueContainer().decode(UiDocument.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let document { try container.encode(document) } else { try container.encode([String]()) }
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

    public var refused: Bool { status == "rejected" || status == "failed" }
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

/// The actions the phone sends, as `ui.schema.json` declares them.
public enum UiCatalog {
    public struct Action: Equatable, Sendable {
        /// The permission the clicking person must hold.
        public var permission: String
        /// The payload fields a held copy keeps: the schema's, less its
        /// secret ones.
        public var kept: Set<String>
    }

    public static let actions: [String: Action] = [
        "default_model.set": Action(permission: "config.manage", kept: ["providerId", "modelId", "effort"]),
    ]

    /// The action as the phone may hold it while it is on its way
    /// (`redactUiAction`): only the fields its schema names and doesn't
    /// mark secret. An action not in the catalog keeps none.
    public static func redacted(_ action: UiAction) -> UiAction {
        let kept = actions[action.type]?.kept ?? []
        return UiAction(type: action.type, payload: .object((action.payload.objectValue ?? [:]).filter { kept.contains($0.key) }))
    }

    /// `uiActionAllowed`, for drawing only: the server decides. `granted`
    /// nil holds every permission (a computer of one's own).
    public static func allowed(_ actionType: String, granted: Set<String>?) -> Bool {
        guard let action = actions[actionType] else { return false }
        guard let granted else { return true }
        return granted.contains(action.permission)
    }
}

/// The props of the components the phone draws, read as their schemas
/// allow and no further: nil where they don't fit, and the component is
/// its fallback line. These checks mirror the `file_tree`, `media` and
/// `default_model` schemas in the vendored `ui.schema.json` and change
/// with them; the vendored `documents` vectors say which props fit.
public enum UiProps {
    /// `file_tree`: 1 to 200 paths of 1 to 1024 characters, none a control.
    public static func fileTree(_ props: JSONValue) -> [String]? {
        guard let object = only(props, ["paths"]), let values = object["paths"]?.arrayValue, (1...200).contains(values.count) else { return nil }
        let paths = values.compactMap(\.stringValue).filter { (1...1024).contains($0.utf16.count) && !$0.unicodeScalars.contains { control($0.value) } }
        return paths.count == values.count ? paths : nil
    }

    /// `media`: 1 to 24 items, each an index among the call's media items
    /// and an optional one-line label of 1 to 80 characters.
    public static func media(_ props: JSONValue) -> [(index: Int, label: String?)]? {
        guard let object = only(props, ["items"]), let values = object["items"]?.arrayValue, (1...24).contains(values.count) else { return nil }
        var items: [(index: Int, label: String?)] = []
        for value in values {
            guard let entry = only(value, ["mediaIndex", "label"]), let number = entry["mediaIndex"]?.numberValue,
                  let index = Int(exactly: number), (0...23).contains(index) else { return nil }
            guard let stated = entry["label"] else { items.append((index, nil)); continue }
            guard let label = stated.stringValue, (1...80).contains(label.utf16.count),
                  !label.unicodeScalars.contains(where: { control($0.value) || bidi($0.value) }) else { return nil }
            items.append((index, label))
        }
        return items
    }

    /// `default_model`: no props at all.
    public static func defaultModel(_ props: JSONValue) -> Bool { only(props, []) != nil }

    /// An object with no key outside `keys`.
    private static func only(_ value: JSONValue, _ keys: Set<String>) -> [String: JSONValue]? {
        guard let object = value.objectValue, object.keys.allSatisfy(keys.contains) else { return nil }
        return object
    }

    private static func control(_ value: UInt32) -> Bool { value <= 0x1F || (0x7F...0x9F).contains(value) }

    private static func bidi(_ value: UInt32) -> Bool {
        value == 0x61C || value == 0x200E || value == 0x200F || (0x202A...0x202E).contains(value) || (0x2066...0x2069).contains(value)
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
        /// `default_model`: drawn from the server's state, as a `UiCard`.
        case defaultModel
        /// A line of plain text: a component the phone doesn't draw, by its
        /// fallback.
        case line(String)
    }

    public var offer: UiOffer
    public var type: String
    public var kind: Kind
    public var fallback: String
    /// Its latest action, from its attempt records and a press on this
    /// phone still on its way.
    public var attempt: UiAttempt?
    /// The server's state a `default_model` draws.
    public var defaults: UiModelDefaults?

    public init(offer: UiOffer, type: String, kind: Kind, fallback: String = "", attempt: UiAttempt? = nil, defaults: UiModelDefaults? = nil) {
        self.offer = offer
        self.type = type
        self.kind = kind
        self.fallback = fallback
        self.attempt = attempt
        self.defaults = defaults
    }

    /// The pieces a document's component draws as: its own, a `media`
    /// component's items (a `show_ui` call's `media`) in rows with their
    /// labels, or its fallback line; nothing where that is blank.
    public static func pieces(_ component: UiComponent, document: String, message: String, media: [Media]) -> [ChatItem.Piece] {
        let offer = UiOffer(messageId: message, uiId: document, componentId: component.id)
        func shown(_ kind: Kind) -> [ChatItem.Piece] { [.ui(UiShown(offer: offer, type: component.type, kind: kind, fallback: component.fallback))] }
        switch component.type {
        case "media":
            if let items = UiProps.media(component.props), items.allSatisfy({ media.indices.contains($0.index) }) {
                return [.mediaRows(items.map { media[$0.index] }, labels: items.map(\.label))]
            }
        case "file_tree":
            if let paths = UiProps.fileTree(component.props) { return shown(.fileTree(UiFileTree.rows(paths))) }
        case "default_model":
            if UiProps.defaultModel(component.props) { return shown(.defaultModel) }
        default:
            break
        }
        let line = component.fallback.trimmingCharacters(in: .whitespacesAndNewlines)
        return line.isEmpty ? [] : shown(.line(line))
    }
}

/// Suggested replies (happy-agent `API.md`, "Quick replies"): not
/// components but words the person may send, drawn under the turn that
/// suggested them for good, the one sent marked. A tap is an ordinary send
/// of the option, naming where it came from (`QuickReply`). They come in a
/// daemon-written `quick_replies` block, or the `quick_replies`
/// presentation of a `suggest_replies` call.
public struct QuickReplies: Equatable, Sendable {
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
