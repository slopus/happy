import Foundation
import HappyWire

/// The default model for new conversations, with the catalog it is picked
/// from (`GET /v0/config`).
public struct UiModelDefaults: Equatable, Sendable {
    public var providerId: String
    public var modelId: String
    public var effort: String
    public var catalog: ModelCatalog

    public init?(response data: Data) {
        guard let catalog = ModelCatalog(response: data),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
        self.catalog = catalog
        providerId = catalog.defaultProviderId
        modelId = catalog.defaultModelId
        effort = value["config"]?["defaults"]?["effort"]?.stringValue ?? catalog.provider(catalog.defaultProviderId)?.models.first { $0.id == catalog.defaultModelId }?.defaultEffort ?? "medium"
    }

    /// The models a default can be set to: each usable account's, in
    /// catalog order.
    public var choices: [(provider: ModelCatalog.Provider, model: ModelCatalog.Model)] {
        catalog.providers.filter { !$0.isDisabled && !$0.hidden }.flatMap { provider in
            provider.models.filter { !provider.hiddenModels.contains($0.id) }.map { (provider, $0) }
        }
    }

    public var title: String {
        let model = catalog.provider(providerId)?.models.first { $0.id == modelId } ?? catalog.models.first { $0.id == modelId }
        return "\(model?.name ?? modelId) · \(effort)"
    }
}

/// The server's state a `default_model` component draws, never its props:
/// read when it is first followed, and again on each `config.updated` and
/// after events were lost, one read at a time. A read that fails (an older
/// server) tells nothing, and the component stays its fallback line.
public struct UiLiveDefaults: Sendable {
    /// What was read, and when by this phone's clock, in ms.
    public struct Reading: Equatable, Sendable {
        public var defaults: UiModelDefaults
        public var at: Double

        public init(defaults: UiModelDefaults, at: Double) {
            self.defaults = defaults
            self.at = at
        }
    }

    private let read: @Sendable () async -> UiModelDefaults?
    private let changes: @Sendable () async -> AsyncStream<Store.ConversationEvent>

    public init(read: @escaping @Sendable () async -> UiModelDefaults?, changes: @escaping @Sendable () async -> AsyncStream<Store.ConversationEvent>) {
        self.read = read
        self.changes = changes
    }

    public init(client: AgentClient, store: Store) {
        self.init(
            read: { (try? await client.modelCatalogResponse()).flatMap { UiModelDefaults(response: Data($0.text.utf8)) } },
            changes: { await store.events(matching: ["config.updated"]) }
        )
    }

    /// Each reading from now until the stream is let go.
    public func readings() -> AsyncStream<Reading> {
        AsyncStream { continuation in
            let task = Task {
                func reading() async {
                    guard let defaults = await read(), !Task.isCancelled else { return }
                    continuation.yield(Reading(defaults: defaults, at: Date().timeIntervalSince1970 * 1000))
                }
                let changes = await changes()
                await reading()
                for await _ in changes { await reading() }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// A component's latest action and how it stands.
public struct UiAttempt: Equatable, Sendable {
    public var type: String
    public var outcome: UiOutcome

    public init(type: String, outcome: UiOutcome) {
        self.type = type
        self.outcome = outcome
    }

    /// Whether a live component still draws it: a refusal this phone
    /// learned of (`learnedAt`) before the server's state was last read
    /// (`readAt`) says nothing against that state, and is left out. Both in
    /// ms by this phone's clock.
    public func stands(learnedAt: Double, readAt: Double?) -> Bool {
        guard outcome.refused, let readAt else { return true }
        return learnedAt >= readAt
    }
}

/// A live component as a card: a title, lines of state, and the controls
/// the state allows. Built from the server's state and the component's
/// latest attempt.
public struct UiCard: Equatable, Sendable {
    public enum Style: Equatable, Sendable { case plain, muted, error }

    public struct Line: Equatable, Sendable {
        public var text: String
        public var style: Style

        public init(_ text: String, _ style: Style = .plain) {
            self.text = text
            self.style = style
        }
    }

    public enum Tap: Equatable, Sendable {
        /// Picks a model and effort, then sends `default_model.set`.
        case pickModel
    }

    public struct Button: Equatable, Sendable {
        public var label: String
        public var tap: Tap
        public var enabled: Bool

        public init(_ label: String, _ tap: Tap, enabled: Bool = true) {
            self.label = label
            self.tap = tap
            self.enabled = enabled
        }
    }

    public var title: String
    public var lines: [Line] = []
    public var buttons: [Button] = []

    public init(title: String, lines: [Line] = [], buttons: [Button] = []) {
        self.title = title
        self.lines = lines
        self.buttons = buttons
    }

    /// `default_model`'s card. `granted` nil holds every permission.
    public static func make(_ shown: UiShown, granted: Set<String>?) -> UiCard {
        var card = UiCard(title: "Default model")
        let busy = shown.attempt?.outcome.status == "pending"
        if let defaults = shown.defaults {
            card.lines.append(Line(defaults.title))
            let allowed = UiCatalog.allowed("default_model.set", granted: granted)
            if !defaults.choices.isEmpty { card.buttons.append(Button("Change", .pickModel, enabled: allowed && !busy)) }
            if !allowed { card.lines.append(Line("Owners and admins can change the default model", .muted)) }
        } else if !shown.fallback.isEmpty {
            card.lines.append(Line(shown.fallback, .muted))
        }
        if busy { card.lines.append(Line("Saving…", .muted)) }
        if let outcome = shown.attempt?.outcome, outcome.refused { card.lines.append(Line(outcome.reason ?? outcome.code ?? "That didn't work", .error)) }
        return card
    }
}
