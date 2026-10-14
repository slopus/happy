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

/// Where the chat reads and sends: the account's own feed, outbox sender
/// and session actions. In debug builds a `fixture:<scenario>` session id
/// reads from the fixture world instead (see Fixtures/).
@MainActor
struct ChatServices {
    var feed: any ChatFeed
    var sender: any ChatSending
    var controls: any ChatControls
    /// The session record and settings, kept current: derived off the main
    /// thread, and handed over only when something the chat draws changed.
    var observeSession: (_ onChange: @escaping @MainActor (ChatSessionState) -> Void) -> ApplyObservation
    /// The same for another session: the one a pending chat was started
    /// beside.
    var observeOtherSession: (_ id: String, _ onChange: @escaping @MainActor (ChatSessionState) -> Void) -> ApplyObservation
    /// Grouped by project, the checkout a session is a tab of, kept
    /// current; nil under the flat list and for a chat in no checkout.
    var observeCheckout: (_ id: String, _ onChange: @escaping @MainActor (WorktreeCheckout?) -> Void) -> ApplyObservation
    /// The chats still on their way to a machine; a `pending-chat:` id is one.
    var pendingChats: PendingChats
    /// The checkout's git status for the header; nil for the fixtures.
    var gitStatus: GitStatusSync?
    /// sessionSetAgentModes({ permissionMode }): a permission answer that
    /// changes the mode for the rest of the session.
    var setPermissionMode: @Sendable (_ mode: String) async -> Void = { _ in }
    /// sessionGoalAction: the goal bar's edit and clear.
    var goalAction: @Sendable (_ action: SessionGoalAction, _ objective: String?) async throws -> Void = { _, _ in }
    /// useSessionQuickActions' resume, for the inactive hint: the session
    /// to open, or nil when there is nothing to open yet.
    var resume: @MainActor (_ session: SessionRecord, _ machine: MachineRecord?) async throws -> String? = { _, _ in nil }
    /// useAttachmentImage's download and decryption: a picture's bytes.
    var attachment: @Sendable (_ ref: String) async throws -> Data = { _ in throw URLError(.fileDoesNotExist) }

    /// `isCurrent` says whether `account` is still the active one; once it
    /// is not, nothing derived from its store reaches the screen.
    static func make(account: AccountSession, sessionId: String, isCurrent: @escaping @MainActor () -> Bool = { true }) -> ChatServices {
        let store = account.store
        let feed = account.homeFeed
        #if DEBUG
        if FixtureScenarios.isFixture(sessionId) {
            let world = FixtureChatWorld.shared
            let record = FixtureScenarios.record(sessionId: sessionId)
            return ChatServices(
                feed: FixtureChatFeed(world: world),
                sender: FixtureChatSender(world: world),
                controls: FixtureChatControls(world: world),
                observeSession: observe(feed: feed, sessionId: sessionId, record: record, isCurrent: isCurrent),
                observeOtherSession: observeOther(feed: feed, isCurrent: isCurrent),
                observeCheckout: observeCheckout(feed: feed, isCurrent: isCurrent),
                pendingChats: account.pendingChats,
                gitStatus: nil,
                attachment: FixtureAttachments.data
            )
        }
        #endif
        return ChatServices(
            feed: account.chatFeed,
            sender: account.sender,
            controls: account.actions,
            observeSession: observe(feed: feed, sessionId: sessionId, isCurrent: isCurrent),
            observeOtherSession: observeOther(feed: feed, isCurrent: isCurrent),
            observeCheckout: observeCheckout(feed: feed, isCurrent: isCurrent),
            pendingChats: account.pendingChats,
            gitStatus: account.gitStatus,
            setPermissionMode: { [actions = account.actions, transport = account.realtime] mode in
                // Fire and forget, as in happy-app; the answer itself has gone.
                try? await actions.sessionSetAgentModes(sessionId: sessionId, patch: SessionAgentModesPatch(permissionMode: .string(mode)), transport: transport)
            },
            goalAction: { [actions = account.actions] action, objective in
                try await actions.sessionGoalAction(sessionId: sessionId, action: action, objective: objective)
            },
            resume: { session, machine in
                // A tap, but still no SQL on the main thread.
                let sessionId = session.id
                let (composer, settings) = await Task.detached(priority: .userInitiated) {
                    ((try? store.composerState(sessionId: sessionId))?.values ?? .object([:]),
                     (try? store.settingsSnapshot())?.synced?.settings)
                }.value
                typealias S = Strings.SessionDetail
                let messages = SessionDetailActions.ResumeMessages(
                    missingMachine: S.resumeSessionMissingMachine,
                    missingBackendId: S.resumeSessionMissingBackendId,
                    sameMachineOnly: S.resumeSessionSameMachineOnly,
                    machineOffline: S.resumeSessionMachineOffline,
                    unexpectedDirectoryPrompt: S.resumeSessionUnexpectedDirectoryPrompt
                )
                return try await account.detailActions.resume(session, machine: machine, settings: settings, composer: composer, messages: messages)
            },
            attachment: { [sync = account.sync] ref in
                try await sync.downloadAttachment(sessionId: sessionId, ref: ref)
            }
        )
    }

    private static func observeOther(
        feed: HomeFeed,
        isCurrent: @escaping @MainActor () -> Bool
    ) -> (_ id: String, _ onChange: @escaping @MainActor (ChatSessionState) -> Void) -> ApplyObservation {
        { id, onChange in
            observe(feed: feed, sessionId: id, isCurrent: isCurrent)(onChange)
        }
    }

    /// `useProjectWorktreeSummary` and `findProjectWorktree`, through the
    /// account's shared home feed: the checkout is found and compared off
    /// the main thread, only while the list is grouped by project, and the
    /// screen hears only when it changed.
    private static func observeCheckout(
        feed: HomeFeed,
        isCurrent: @escaping @MainActor () -> Bool
    ) -> (_ id: String, _ onChange: @escaping @MainActor (WorktreeCheckout?) -> Void) -> ApplyObservation {
        { id, onChange in
            // The state is what was applied: nil before the first apply.
            let pipeline = ApplyPipeline<HomeSnapshot?, WorktreeCheckout??, WorktreeCheckout?>(
                input: nil,
                state: nil,
                derive: { snapshot, applied in
                    guard let snapshot else { return nil }
                    let checkout = AccountSettings(snapshot.settings).sessionListGrouping == .project
                        ? WorktreeCheckout.locate(id, in: snapshot)
                        : nil
                    return applied == .some(checkout) ? nil : (checkout, .some(checkout))
                },
                apply: { checkout in
                    guard isCurrent() else { return false }
                    onChange(checkout)
                    return true
                }
            )
            pipeline.follow(feed.snapshots()) { $0 = $1 }
            return pipeline.observation
        }
    }

    /// Through the account's shared home feed: one read for the record and
    /// the settings, so the two always agree. The state is reduced to what
    /// the chat draws and compared off the main thread, so a heartbeat, a
    /// message cursor or another session's change applies nothing here.
    /// `record` stands in for the stored one (the debug fixtures).
    static func observe(
        feed: HomeFeed,
        sessionId: String,
        record: SessionRecord? = nil,
        isCurrent: @escaping @MainActor () -> Bool
    ) -> (_ onChange: @escaping @MainActor (ChatSessionState) -> Void) -> ApplyObservation {
        { onChange in
            let pipeline = ApplyPipeline<HomeSnapshot?, ChatSessionState?, ChatSessionState>(
                input: nil,
                state: nil,
                derive: { snapshot, applied in
                    guard let snapshot else { return nil }
                    let state = ChatSessionState(snapshot, sessionId: sessionId, record: record)
                    return state == applied ? nil : (state, state)
                },
                apply: { state in
                    // Another account took over while this was derived.
                    guard isCurrent() else { return false }
                    ApplyPerf.measure(.chatSession) {
                        onChange(state)
                        return 1
                    }
                    return true
                }
            )
            pipeline.follow(feed.snapshots()) { $0 = $1 }
            return pipeline.observation
        }
    }
}
#endif
