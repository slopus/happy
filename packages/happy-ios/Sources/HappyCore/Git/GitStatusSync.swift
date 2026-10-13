import Foundation
import HappyStore

/// One instance per account. Shares refreshes between sessions in the same checkout.
public actor GitStatusSync {
    let actions: SessionActions
    let store: LocalStore
    private struct Project: Hashable, Sendable {
        var machineId: String
        var path: String
    }
    private var sessions: [String: Project] = [:]
    private var cache: [Project: GitStatus] = [:]
    private var observers: [String: [UUID: AsyncStream<GitStatus?>.Continuation]] = [:]
    private enum FetchResult: Sendable {
        case status(GitStatus)
        case notRepository
        case failed
    }
    private var refreshes: [Project: Task<FetchResult, Never>] = [:]
    private var timers: [Project: Task<Void, Never>] = [:]
    private var refreshAgain: Set<Project> = []
    public init(actions: SessionActions, store: LocalStore) {
        self.actions = actions
        self.store = store
    }
    /// Ports gitStatusSync.getSync: immediate snapshot followed by refresh results.
    /// Call refresh(sessionId:) once when opening the screen; subsequent account
    /// socket updates invalidate this observed checkout automatically.
    public func observe(sessionId: String) -> AsyncStream<GitStatus?> {
        let id = UUID()
        let project = project(sessionId)
        let (stream, continuation) = AsyncStream<GitStatus?>.makeStream(bufferingPolicy: .bufferingNewest(1))
        observers[sessionId, default: [:]][id] = continuation
        continuation.yield(project.flatMap { cache[$0] })
        continuation.onTermination = { [weak self] _ in Task { await self?.removeObserver(sessionId: sessionId, id: id) } }
        return stream
    }
    /// Ports gitStatusSync.getSync/session refresh and gitStatusFiles.getGitStatusFiles.
    @discardableResult public func refresh(sessionId: String) async -> GitStatus? {
        guard let project = project(sessionId) else { return nil }
        if let refresh = refreshes[project] {
            let answer = await refresh.value
            if case .status(let status) = answer { return status }
            return cache[project]
        }
        let actions = self.actions
        let task = Task<FetchResult, Never> {
            do {
                let check = try await actions.sessionBash(sessionId: sessionId, request: SessionBashRequest(
                    command: "git rev-parse --is-inside-work-tree", cwd: project.path, timeout: 5000
                ))
                guard !Task.isCancelled else { return .failed }
                guard check.success, check.exitCode == 0 else {
                    // A transport refusal retains a previous snapshot. Only a git
                    // process exit proves that this checkout is not a repository.
                    return check.exitCode > 0 ? .notRepository : .failed
                }
                let status = try await actions.sessionBash(sessionId: sessionId, request: SessionBashRequest(
                    command: "git -c core.quotepath=false status --porcelain=v2 --branch --show-stash --untracked-files=all",
                    cwd: project.path, timeout: 10000
                ))
                guard status.success, status.exitCode == 0, !Task.isCancelled else { return .failed }
                let unstaged = try await actions.sessionBash(sessionId: sessionId, request: SessionBashRequest(
                    command: "git -c core.quotepath=false diff --numstat", cwd: project.path, timeout: 10000
                ))
                guard !Task.isCancelled else { return .failed }
                let staged = try await actions.sessionBash(sessionId: sessionId, request: SessionBashRequest(
                    command: "git -c core.quotepath=false diff --cached --numstat", cwd: project.path, timeout: 10000
                ))
                guard !Task.isCancelled else { return .failed }
                return .status(GitStatusParser.parse(
                    status: status.stdout, unstagedNumstat: unstaged.success ? unstaged.stdout : "",
                    stagedNumstat: staged.success ? staged.stdout : "", now: Int64(Date().timeIntervalSince1970 * 1000)
                ))
            } catch { return .failed }
        }
        refreshes[project] = task
        let result = await task.value
        guard !task.isCancelled else { return nil }
        refreshes.removeValue(forKey: project)
        if refreshAgain.remove(project) != nil {
            Task { await self.refresh(sessionId: sessionId) }
        }
        switch result {
        case .status(let status): cache[project] = status
        case .notRepository: cache.removeValue(forKey: project)
        case .failed: return cache[project]
        }
        publish(project)
        return cache[project]
    }
    /// Ports gitStatusSync.invalidate (300ms debounce).
    public func invalidate(sessionId: String) {
        guard sessions[sessionId] != nil, let project = project(sessionId) else { return }
        if refreshes[project] != nil { refreshAgain.insert(project) }
        timers[project]?.cancel()
        timers[project] = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            await self?.debouncedRefresh(sessionId: sessionId, project: project)
        }
    }
    /// Ports gitStatusSync.stop.
    public func stop(sessionId: String) {
        guard let project = sessions.removeValue(forKey: sessionId) else { return }
        for observer in observers.removeValue(forKey: sessionId)?.values ?? Dictionary<UUID, AsyncStream<GitStatus?>.Continuation>().values { observer.finish() }
        if !sessions.values.contains(project) {
            timers.removeValue(forKey: project)?.cancel()
            refreshes.removeValue(forKey: project)?.cancel()
            refreshAgain.remove(project)
        }
    }
    /// Ports gitStatusSync.clearForSession.
    public func clearForSession(sessionId: String) {
        let project = sessions[sessionId]
        stop(sessionId: sessionId)
        if let project, !sessions.values.contains(project) { cache.removeValue(forKey: project) }
    }
    /// Stops all account refreshes on account switch.
    public func stop() {
        for task in timers.values { task.cancel() }
        for task in refreshes.values { task.cancel() }
        for group in observers.values { for observer in group.values { observer.finish() } }
        timers.removeAll()
        refreshes.removeAll()
        observers.removeAll()
        sessions.removeAll()
        cache.removeAll()
        refreshAgain.removeAll()
    }

    private func project(_ sessionId: String) -> Project? {
        guard let record = try? store.session(id: sessionId), let machineId = record.metadata?["machineId"]?.stringValue,
              let path = record.metadata?["path"]?.stringValue else { return nil }
        let project = Project(machineId: machineId, path: path)
        sessions[sessionId] = project
        return project
    }
    private func publish(_ project: Project) {
        for (sessionId, current) in sessions where current == project {
            for observer in observers[sessionId]?.values ?? Dictionary<UUID, AsyncStream<GitStatus?>.Continuation>().values { observer.yield(cache[project]) }
        }
    }
    private func debouncedRefresh(sessionId: String, project: Project) async {
        timers.removeValue(forKey: project)
        await refresh(sessionId: sessionId)
    }
    private func removeObserver(sessionId: String, id: UUID) {
        observers[sessionId]?.removeValue(forKey: id)
        if observers[sessionId]?.isEmpty == true { stop(sessionId: sessionId) }
    }
}
