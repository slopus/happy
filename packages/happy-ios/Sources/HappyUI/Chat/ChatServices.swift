#if canImport(UIKit)
import Foundation
import HappyCore
import HappyStore
import HappyWire

/// What the chat screen does to a session besides sending: answer
/// permission requests and questions, and stop the agent. `SessionActions`
/// is the real one; the debug fixtures fake it.
public protocol ChatControls: Sendable {
    func allow(sessionId: String, permissionId: String, mode: String?, allowedTools: [String]?, decision: ToolPermission.Decision?, updatedInput: JSONValue?) async throws
    func deny(sessionId: String, permissionId: String, mode: String?, allowedTools: [String]?, decision: ToolPermission.Decision?) async throws
    func answerQuestion(sessionId: String, id: String, answers: JSONValue, kind: String) async throws
    func cancelQuestion(sessionId: String, id: String, kind: String) async throws
    func abort(sessionId: String) async throws
}

extension SessionActions: ChatControls {}

/// The session around the chat: its record (metadata, agent state,
/// thinking) and the account settings that change how the chat reads.
public struct ChatSessionState: Equatable, Sendable {
    /// Nil until the session is in the store, and once it is gone from it.
    public var record: SessionRecord?
    public var settings: AccountSettings

    public init(record: SessionRecord?, settings: AccountSettings) {
        self.record = record
        self.settings = settings
    }

    public var metadata: JSONValue? { record?.metadata }
    public var agentState: JSONValue? { record?.agentState }
    public var thinking: Bool { record?.thinking ?? false }

    /// `settings.groupToolCalls`: fold finished turns behind "Worked for …".
    public var groupToolCalls: Bool { settings.bool("groupToolCalls") }
    /// `settings.compactToolCalls`: every tool as a one-line row.
    public var compactToolCalls: Bool { settings.bool("compactToolCalls") }

    /// The terminal has control, so permissions are answered there
    /// (`usesControlledSessionUi && agentState.controlledByUser`).
    public var controlledByUser: Bool {
        guard metadata?["client"]?["id"]?.stringValue != "rig" else { return false }
        return agentState?["controlledByUser"]?.boolValue ?? false
    }

    /// `agentState.requests` is not empty.
    public var hasPendingPermission: Bool { record?.hasPendingPermissionRequests ?? false }

    /// The flavor the session was started with; absent means Claude.
    public var flavor: String? { metadata?["flavor"]?.stringValue }
}

/// Where the chat reads and sends: the account's own feed, outbox sender
/// and session actions. In debug builds a `fixture:<scenario>` session id
/// reads from the fixture world instead (see Fixtures/).
@MainActor
struct ChatServices {
    var feed: any ChatFeed
    var sender: any ChatSending
    var controls: any ChatControls
    /// The session record and settings, kept current.
    var observeSession: (_ onChange: @escaping @MainActor (ChatSessionState) -> Void) -> StoreObservation
    /// sessionSetAgentModes({ permissionMode }): a permission answer that
    /// changes the mode for the rest of the session.
    var setPermissionMode: @Sendable (_ mode: String) async -> Void = { _ in }

    static func make(account: AccountSession, sessionId: String) -> ChatServices {
        let store = account.store
        #if DEBUG
        if FixtureScenarios.isFixture(sessionId) {
            let world = FixtureChatWorld.shared
            let record = FixtureScenarios.record(sessionId: sessionId)
            return ChatServices(
                feed: FixtureChatFeed(world: world),
                sender: FixtureChatSender(world: world),
                controls: FixtureChatControls(world: world),
                observeSession: observe(store: store) { _ in record }
            )
        }
        #endif
        return ChatServices(
            feed: account.chatFeed,
            sender: account.sender,
            controls: account.actions,
            observeSession: observe(store: store) { snapshot in
                snapshot.sessions.first { $0.id == sessionId }
            },
            setPermissionMode: { [actions = account.actions, transport = account.realtime] mode in
                // Fire and forget, as in happy-app; the answer itself has gone.
                try? await actions.sessionSetAgentModes(sessionId: sessionId, patch: SessionAgentModesPatch(permissionMode: .string(mode)), transport: transport)
            }
        )
    }

    /// Through the home observation: public, and one read for the record and
    /// the settings, so the two always agree.
    private static func observe(
        store: LocalStore,
        record: @escaping @MainActor (HomeSnapshot) -> SessionRecord?
    ) -> (_ onChange: @escaping @MainActor (ChatSessionState) -> Void) -> StoreObservation {
        { onChange in
            var last: ChatSessionState?
            return store.observeHome { snapshot in
                let state = ChatSessionState(record: record(snapshot), settings: AccountSettings(snapshot.settings))
                guard state != last else { return }
                last = state
                onChange(state)
            }
        }
    }
}
#endif
