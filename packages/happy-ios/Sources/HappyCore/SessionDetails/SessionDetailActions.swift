import Foundation
import HappyStore
import HappyWire

/// What session info and the machine screen do when a row is pressed, after
/// info.tsx, useSessionQuickActions.ts, useWorktreeCleanup.ts and
/// machine/[id].tsx. Questions for the person (the worktree prompt) come in
/// as closures, so the flows run and are tested without UIKit.
public struct SessionDetailActions: Sendable {
    let sessions: SessionActions
    let machines: MachineActions
    let store: LocalStore
    let sync: SyncEngine
    let metadataTransport: any MetadataUpdateTransport

    public init(sessions: SessionActions, machines: MachineActions, store: LocalStore, sync: SyncEngine, metadataTransport: any MetadataUpdateTransport) {
        self.sessions = sessions
        self.machines = machines
        self.store = store
        self.sync = sync
        self.metadataTransport = metadataTransport
    }

    /// happy-app's HappyError: a failure with the words to show. Anything
    /// else reads "Unknown error" (useHappyAction).
    public struct Failure: Error, Equatable, Sendable {
        public var message: String
        public init(_ message: String) { self.message = message }
    }

    /// Answers the worktree cleanup prompt: true deletes the worktree.
    public typealias ConfirmWorktreeCleanup = @Sendable () async -> Bool

    // MARK: Worktree (useWorktreeCleanup.ts)

    /// Offers to delete the worktree a session ran in, only when no other
    /// live session uses it and git says it's clean.
    public func maybeCleanupWorktree(sessionId: String, path: String?, machineId: String?, confirm: ConfirmWorktreeCleanup) async {
        guard let path, let machineId, SessionDetails.isWorktreePath(path) else { return }
        let others = ((try? store.sessions()) ?? []).contains { other in
            other.id != sessionId && other.active && other.metadata?["path"]?.stringValue == path
        }
        if others { return }
        guard let status = try? await machines.machineBash(machineId: machineId, command: "git status --porcelain", cwd: path),
              status.success, status.stdout.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return }
        guard await confirm(), let remove = SessionDetails.removeWorktreeCommand(path) else { return }
        _ = try? await machines.machineBash(machineId: machineId, command: remove.command, cwd: remove.cwd)
    }

    // MARK: Session

    /// info.tsx `performArchive`: worktree prompt (not for bots), then stop
    /// the agent, falling back to archiving on the server.
    public func archive(_ session: SessionRecord, confirmWorktreeCleanup: ConfirmWorktreeCleanup) async throws {
        let metadata = session.metadata
        if !session.isBot {
            await maybeCleanupWorktree(
                sessionId: session.id,
                path: metadata?["path"]?.stringValue,
                machineId: metadata?["machineId"]?.stringValue,
                confirm: confirmWorktreeCleanup
            )
        }
        do {
            try await sessions.archive(sessionId: session.id)
        } catch SessionActionError.botNeedsMachine {
            throw Failure(Self.botArchiveMessage)
        } catch SessionActionError.unknownSession {
            throw Failure(Self.failedToArchiveSession)
        } catch let error as SessionActionError {
            throw Failure(Self.message(error) ?? Self.failedToArchiveSession)
        }
    }

    /// info.tsx `performDelete`, once the worktree question is settled
    /// and the screen has gone: stop the agent if it may still run, then
    /// delete. Bots can't be deleted.
    public func delete(_ session: SessionRecord) async throws {
        if session.isBot { throw Failure(Self.botDeleteMessage) }
        if session.active {
            _ = try? await sessions.sessionKill(sessionId: session.id)
        }
        do {
            try await sessions.delete(sessionId: session.id)
        } catch {
            throw Failure(Self.failedToDeleteSession)
        }
    }

    /// useSessionQuickActions.ts `performResume`. Returns the session to
    /// open: the same id, since a resumed session keeps its messages.
    public func resume(_ session: SessionRecord, machine: MachineRecord?, settings: JSONValue?, composer: JSONValue, messages: ResumeMessages) async throws -> String? {
        let availability = SessionDetails.resumeAvailability(session, machine: machine)
        guard availability.canResume else { throw Failure(messages.message(for: availability)) }
        guard let machineId = SessionDetails.truthy(session.metadata?["machineId"]) else {
            throw Failure(messages.missingMachine)
        }
        let meta: [String: JSONValue]
        do {
            meta = try UserMessageEncoder.modeMeta(metadata: session.metadata ?? .object([:]), composer: composer, settings: settings)
        } catch let error as UnsupportedPermissionModeError {
            // Refused rather than swapped for a default, as happy-app does.
            throw Failure(error.errorDescription ?? "")
        }
        let model = meta["model"]?.stringValue
        let permissionMode = meta["permissionMode"]?.stringValue
        switch await machines.machineResumeSession(machineId: machineId, sessionId: session.id, model: model, permissionMode: permissionMode) {
        case .success(let sessionId):
            await sync.run(.sessions)
            if let local = composer["permissionMode"]?.stringValue {
                let sessions = self.sessions
                let transport = metadataTransport
                Task {
                    try? await sessions.sessionSetAgentModes(
                        sessionId: sessionId,
                        patch: SessionAgentModesPatch(permissionMode: .string(local)),
                        transport: transport
                    )
                }
            }
            return sessionId
        case .requestToApproveDirectoryCreation:
            throw Failure(messages.unexpectedDirectoryPrompt)
        case .error(let message):
            throw Failure(message)
        case .pending:
            // happy-app's switch has no case for it and does nothing.
            return nil
        }
    }

    /// useSessionQuickActions.ts `performFork`: copy the transcript into a
    /// new session on the same machine. Returns the new session.
    public func fork(_ session: SessionRecord, canFork: Bool, messages: ForkMessages) async throws -> String {
        guard canFork, let source = SessionDetails.forkSource(session) else { throw Failure(messages.missingMetadata) }
        switch await machines.forkAndSpawn(source: source) {
        case .success(let sessionId):
            return sessionId
        case .error(let message):
            throw Failure(message)
        default:
            throw Failure(messages.generic)
        }
    }

    // MARK: Machine (machine/[id].tsx)

    /// Stops the daemon and refreshes machines; the message is the daemon's.
    public func stopDaemon(machineId: String) async throws -> String {
        let result = try await machines.machineStopDaemon(machineId: machineId)
        await sync.run(.machines)
        return result.message
    }

    /// Writes a new display name, or none when `displayName` is empty.
    /// A failure refreshes machines and is rethrown.
    public func renameMachine(_ machine: MachineRecord, displayName: String) async throws {
        do {
            _ = try await machines.machineUpdateMetadata(
                machineId: machine.id,
                metadata: MachineDetailsModel.renamedMetadata(machine.metadata, displayName: displayName),
                expectedVersion: machine.metadataVersion
            )
        } catch {
            await sync.run(.machines)
            throw error
        }
    }

    public func deleteMachine(machineId: String) async -> MachineOperationResult {
        await machines.machineDelete(machineId: machineId)
    }

    public func refreshMachines() async {
        await sync.run(.machines)
    }

    // MARK: Copy

    /// Hard-coded in useSessionQuickActions.ts / info.tsx, not in en.ts.
    public static let botArchiveMessage = "Connect to the bot’s machine to archive it."
    public static let botDeleteMessage = "Archive the bot instead of deleting its conversation."
    static let failedToArchiveSession = "Failed to archive session"
    static let failedToDeleteSession = "Failed to delete session"

    static func message(_ error: SessionActionError) -> String? {
        if case .failed(let message) = error, !message.isEmpty { return message }
        return nil
    }

    /// The translated resume messages (sessionInfo.resumeSession*).
    public struct ResumeMessages: Sendable {
        public var missingMachine: String
        public var missingBackendId: String
        public var sameMachineOnly: String
        public var machineOffline: String
        public var unexpectedDirectoryPrompt: String

        public init(missingMachine: String, missingBackendId: String, sameMachineOnly: String, machineOffline: String, unexpectedDirectoryPrompt: String) {
            self.missingMachine = missingMachine
            self.missingBackendId = missingBackendId
            self.sameMachineOnly = sameMachineOnly
            self.machineOffline = machineOffline
            self.unexpectedDirectoryPrompt = unexpectedDirectoryPrompt
        }

        public func message(for availability: SessionDetails.ResumeAvailability) -> String {
            switch availability {
            case .missingMachine: missingMachine
            case .missingBackendId: missingBackendId
            case .sameMachineOnly: sameMachineOnly
            case .machineOffline: machineOffline
            case .hidden, .available: ""
            }
        }
    }

    public struct ForkMessages: Sendable {
        public var missingMetadata: String
        public var generic: String

        public init(missingMetadata: String, generic: String) {
            self.missingMetadata = missingMetadata
            self.generic = generic
        }
    }
}
