import Foundation
import HappyWire

/// Chat UI (happy-agent `API.md`, "Chat UI", protocol 35): a document, a
/// flat list of typed components, in a `ui` block of a message the daemon
/// wrote or a `ui` presentation of a `show_ui` call. Every press is one
/// `POST /v0/agents/:agentId/actions`. The rules here are
/// `@slopus/happy-agent-client`'s `sources/ui`, checked against its
/// `fixtures/ui` (`ChatUiTests`).
public enum ChatUi {
    /// The protocol that carries chat UI. Below it, or without the header,
    /// the daemon sends each document as its fallback text.
    public static let protocolVersion = 35
    public static let protocolHeader = "Happy-Protocol"

    /// The components the phone draws itself; every other one shows its
    /// fallback line, and `hidden` ones nothing (the phone app's download
    /// codes, on the phone).
    public static let drawn: Set<String> = ["images", "choice", "checklist", "text_field", "file_tree"]
    public static let hidden: Set<String> = ["phone_app"]

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
    /// The person's message it became; for one refused as `offer_closed`, the one that won.
    public var messageId: String?

    public init(status: String, code: String? = nil, reason: String? = nil, messageId: String? = nil) {
        self.status = status
        self.code = code
        self.reason = reason
        self.messageId = messageId
    }
}

/// An `action` block: in an attempt record (a service message), or in the
/// person's message an action became. Its payload has no secret.
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

/// One action of a bundle: whether it becomes the person's words, whether
/// it answers its offer, and what it needs.
public struct UiActionDefinition: Equatable, Sendable {
    public var message: Bool
    public var once: Bool
    public var permission: UiPermission

    public init(message: Bool, once: Bool = false, permission: UiPermission = .id("content.write")) {
        self.message = message
        self.once = once
        self.permission = permission
    }
}

/// Catalog v1's actions and the shared functions over them.
public enum UiCatalog {
    public static let version = 1

    private static let byTarget = UiPermission.byProp(prop: "target", map: ["team": "providers.manage", "private": "providers.own"], default: "providers.own")
    private static func silent(_ permission: UiPermission) -> UiActionDefinition { UiActionDefinition(message: false, permission: permission) }

    /// Every action, by `<component>.<action>`, as `ui.schema.json` declares it.
    public static let actions: [String: UiActionDefinition] = [
        "choice.choose": UiActionDefinition(message: true, once: true),
        "checklist.submit": UiActionDefinition(message: true, once: true),
        "text_field.submit": UiActionDefinition(message: true, once: true),
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

    /// `uiActionText`: the person's words for a `"message"` action against
    /// the offer's stored props; nil for a silent one or a payload that
    /// doesn't fit.
    public static func text(type: String, props: JSONValue, action: UiAction) -> String? {
        guard props.objectValue != nil, action.payload.objectValue != nil else { return nil }
        let options = (props["options"]?.arrayValue ?? []).compactMap { option -> (id: String, label: String)? in
            guard let id = option["id"]?.stringValue, let label = option["label"]?.stringValue else { return nil }
            return (id, label)
        }
        switch action.type {
        case "choice.choose":
            guard type == "choice" else { return nil }
            return options.first { .string($0.id) == action.payload["optionId"] }?.label
        case "checklist.submit":
            guard type == "checklist", let submit = props["submitLabel"]?.stringValue, let selected = action.payload["selected"]?.arrayValue else { return nil }
            guard selected.allSatisfy({ id in options.contains { .string($0.id) == id } }) else { return nil }
            let labels = options.filter { selected.contains(.string($0.id)) }.map(\.label)
            if labels.isEmpty { return props["emptyLabel"]?.stringValue ?? submit }
            return "\(submit): \(labels.joined(separator: ", "))"
        case "text_field.submit":
            guard type == "text_field" else { return nil }
            return action.payload["text"]?.stringValue
        default:
            return nil
        }
    }

    public enum OfferState: String, Equatable, Sendable { case open, `repeat`, closed }

    /// `uiOfferState`, the open-offer rule.
    public static func offerState(once: Bool, accepted: UiAction?, personSpokeAfter: Bool, action: UiAction) -> OfferState {
        guard once else { return .open }
        if let accepted { return accepted == action ? .repeat : .closed }
        return personSpokeAfter ? .closed : .open
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
    public struct Option: Equatable, Sendable {
        public var id: String
        public var label: String
        public var detail: String?
        public var primary: Bool
        public var checked: Bool

        public init(id: String, label: String, detail: String? = nil, primary: Bool = false, checked: Bool = false) {
            self.id = id
            self.label = label
            self.detail = detail
            self.primary = primary
            self.checked = checked
        }
    }

    public enum Kind: Equatable, Sendable {
        case choice([Option])
        case checklist([Option], submitLabel: String, emptyLabel: String?)
        case textField(label: String, placeholder: String?, submitLabel: String)
        case fileTree([UiFileTree.Row])
        /// A line of plain text: a component the phone doesn't draw, by its
        /// fallback, or an `images` component's captions.
        case line(String)
    }

    /// How its offer stands, from its attempt records, the person's
    /// messages after it, and a press on this phone still on its way.
    public struct State: Equatable, Sendable {
        /// The accepted answer's payload.
        public var answer: JSONValue?
        /// A press on its way.
        public var pending: JSONValue?
        /// It takes no more answers.
        public var closed = false
        /// A checklist's ticks as the person left them here; nil for its props'.
        public var ticked: Set<String>?

        public init(answer: JSONValue? = nil, pending: JSONValue? = nil, closed: Bool = false, ticked: Set<String>? = nil) {
            self.answer = answer
            self.pending = pending
            self.closed = closed
            self.ticked = ticked
        }

        /// Nothing more can be sent from it.
        public var settled: Bool { closed || answer != nil || pending != nil }
    }

    public var offer: UiOffer
    public var type: String
    /// As stored, which an action's words and permission are read against.
    public var props: JSONValue
    public var kind: Kind
    public var state = State()

    public init(offer: UiOffer, type: String, props: JSONValue, kind: Kind, state: State = State()) {
        self.offer = offer
        self.type = type
        self.props = props
        self.kind = kind
        self.state = state
    }

    /// A checklist's ticks now.
    public var ticked: Set<String> {
        if let ticked = state.ticked { return ticked }
        if let answer = state.answer ?? state.pending, let selected = answer["selected"]?.arrayValue { return Set(selected.compactMap(\.stringValue)) }
        guard case .checklist(let options, _, _) = kind else { return [] }
        return Set(options.filter(\.checked).map(\.id))
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
        func options(_ value: JSONValue?) -> [Option]? {
            guard let list = value?.arrayValue, !list.isEmpty else { return nil }
            let read = list.compactMap { entry -> Option? in
                guard let id = entry["id"]?.stringValue, let label = entry["label"]?.stringValue else { return nil }
                return Option(id: id, label: label, detail: entry["detail"]?.stringValue, primary: entry["primary"]?.boolValue ?? false, checked: entry["checked"]?.boolValue ?? false)
            }
            return read.count == list.count ? read : nil
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
        case "choice":
            kind = options(props["options"]).map { .choice($0) }
        case "checklist":
            kind = options(props["options"]).flatMap { list in
                props["submitLabel"]?.stringValue.map { .checklist(list, submitLabel: $0, emptyLabel: props["emptyLabel"]?.stringValue) }
            }
        case "text_field":
            kind = props["label"]?.stringValue.flatMap { label in
                props["submitLabel"]?.stringValue.map { .textField(label: label, placeholder: props["placeholder"]?.stringValue, submitLabel: $0) }
            }
        case "file_tree":
            let paths = (props["paths"]?.arrayValue ?? []).compactMap(\.stringValue)
            kind = paths.isEmpty ? nil : .fileTree(UiFileTree.rows(paths))
        default:
            kind = nil
        }
        guard let kind else { return line(component.fallback) }
        return [.ui(UiShown(offer: offer, type: component.type, props: props, kind: kind))]
    }
}
