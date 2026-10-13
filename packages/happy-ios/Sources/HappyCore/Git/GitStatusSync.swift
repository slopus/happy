import Foundation
import HappyStore

/// A checkout: the computer and the path, as storage.ts
/// `getSessionPathKey` joins them for `pathGitStatus`.
public struct GitCheckoutKey: Hashable, Sendable {
    public var machineId: String
    public var path: String

    public init(machineId: String, path: String) {
        self.machineId = machineId
        self.path = path
    }
}

/// What a checkout's heading shows of its status (ProjectGroup.tsx
/// `WorkspaceSection`): the branch and the unstaged line counts.
public struct GitHeadingStatus: Equatable, Sendable {
    public var branch: String?
    public var unstagedLinesAdded: Int
    public var unstagedLinesRemoved: Int

    public init(branch: String?, unstagedLinesAdded: Int, unstagedLinesRemoved: Int) {
        self.branch = branch
        self.unstagedLinesAdded = unstagedLinesAdded
        self.unstagedLinesRemoved = unstagedLinesRemoved
    }

    public init(_ status: GitStatus) {
        self.init(branch: status.branch, unstagedLinesAdded: status.unstagedLinesAdded, unstagedLinesRemoved: status.unstagedLinesRemoved)
    }
}

/// A screen's interest in checkouts it shows without opening them; see
/// `GitStatusSync.interest()`. Releasing it withdraws the interest.
public final class GitCheckoutInterest: Sendable {
    private let continuation: AsyncStream<Set<GitCheckoutKey>>.Continuation

    init(_ continuation: AsyncStream<Set<GitCheckoutKey>>.Continuation) {
        self.continuation = continuation
    }

    /// The checkouts shown now, replacing the last set.
    public func set(_ checkouts: Set<GitCheckoutKey>) {
        continuation.yield(checkouts)
    }

    deinit { continuation.finish() }
}

/// One instance per account. Shares refreshes between sessions in the same checkout.
public actor GitStatusSync {
    let actions: SessionActions
    let store: LocalStore
    private typealias Project = GitCheckoutKey
    private var sessions: [String: Project] = [:]
    private var cache: [Project: GitStatus] = [:]
    private var observers: [String: [UUID: AsyncStream<GitStatus?>.Continuation]] = [:]
    /// `cache` reduced to what a heading shows, and who follows it.
    private var headings: [Project: GitHeadingStatus] = [:]
    private var headingObservers: [UUID: AsyncStream<[GitCheckoutKey: GitHeadingStatus]>.Continuation] = [:]
    /// Each screen's checkouts (`interest()`), and all of them together.
    private var interests: [UUID: Set<Project>] = [:]
    private var interested: Set<Project> = []
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
    /// Every checkout's status as far as it is known, reduced to what a
    /// heading shows: the map now, then again each time that changes. It
    /// only reads what has already been fetched (storage.ts
    /// `useSessionGitStatus` reads `pathGitStatus`); following it asks no
    /// computer for anything.
    public func headingStatuses() -> AsyncStream<[GitCheckoutKey: GitHeadingStatus]> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<[GitCheckoutKey: GitHeadingStatus]>.makeStream(bufferingPolicy: .bufferingNewest(1))
        headingObservers[id] = continuation
        continuation.yield(headings)
        continuation.onTermination = { [weak self] _ in Task { await self?.removeHeadingObserver(id) } }
        return stream
    }
    /// Checkouts a screen shows without opening them (the tablet sidebar's
    /// headings). sync.ts refreshes a session's checkout on each new message
    /// it gets (`onSessionDataUpdated`); here only these checkouts and the
    /// ones a screen observes are refreshed that way. Showing a checkout
    /// fetches nothing by itself. The sets are taken in the order given.
    public nonisolated func interest() -> GitCheckoutInterest {
        let (stream, continuation) = AsyncStream<Set<GitCheckoutKey>>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let id = UUID()
        Task { [weak self] in
            for await checkouts in stream { await self?.setInterest(checkouts, id: id) }
            await self?.setInterest([], id: id)
        }
        return GitCheckoutInterest(continuation)
    }
    /// The checkouts screens are interested in now.
    var interestedCheckouts: Set<GitCheckoutKey> { interested }
    /// Ports gitStatusSync.getSync/session refresh and gitStatusFiles.getGitStatusFiles.
    @discardableResult public func refresh(sessionId: String) async -> GitStatus? {
        guard let project = project(sessionId) else { return nil }
        return await fetch(sessionId: sessionId, project: project)
    }
    /// One checkout's status, asked of `sessionId`'s computer, shared with
    /// a fetch already running for it.
    @discardableResult private func fetch(sessionId: String, project: Project) async -> GitStatus? {
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
            Task { await self.fetch(sessionId: sessionId, project: project) }
        }
        switch result {
        case .status(let status): cache[project] = status
        case .notRepository: cache.removeValue(forKey: project)
        case .failed: return cache[project]
        }
        publish(project)
        return cache[project]
    }
    /// Ports gitStatusSync.invalidate (300ms debounce), for an observed
    /// session or one in a checkout of `interest()`.
    public func invalidate(sessionId: String) {
        let project: Project
        if sessions[sessionId] != nil, let observed = self.project(sessionId) {
            project = observed
        } else if !interested.isEmpty, let shown = checkout(sessionId), interested.contains(shown) {
            project = shown
        } else {
            return
        }
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
        if !sessions.values.contains(project), !interested.contains(project) { cancelWork(project) }
    }
    /// Ports gitStatusSync.clearForSession.
    public func clearForSession(sessionId: String) {
        let project = sessions[sessionId]
        stop(sessionId: sessionId)
        if let project, !sessions.values.contains(project) {
            cache.removeValue(forKey: project)
            publishHeading(project)
        }
    }
    /// Stops all account refreshes on account switch.
    public func stop() {
        for task in timers.values { task.cancel() }
        for task in refreshes.values { task.cancel() }
        for group in observers.values { for observer in group.values { observer.finish() } }
        for observer in headingObservers.values { observer.finish() }
        headingObservers.removeAll()
        headings.removeAll()
        interests.removeAll()
        interested.removeAll()
        timers.removeAll()
        refreshes.removeAll()
        observers.removeAll()
        sessions.removeAll()
        cache.removeAll()
        refreshAgain.removeAll()
    }

    /// Looks the session's checkout up and remembers it as observed.
    private func project(_ sessionId: String) -> Project? {
        guard let project = checkout(sessionId) else { return nil }
        sessions[sessionId] = project
        return project
    }
    /// Looks the session's checkout up, remembering nothing.
    private func checkout(_ sessionId: String) -> Project? {
        guard let record = try? store.session(id: sessionId), let machineId = record.metadata?["machineId"]?.stringValue,
              let path = record.metadata?["path"]?.stringValue else { return nil }
        return Project(machineId: machineId, path: path)
    }
    private func publish(_ project: Project) {
        for (sessionId, current) in sessions where current == project {
            for observer in observers[sessionId]?.values ?? Dictionary<UUID, AsyncStream<GitStatus?>.Continuation>().values { observer.yield(cache[project]) }
        }
        publishHeading(project)
    }
    /// Tells the heading followers, only when what a heading shows changed.
    private func publishHeading(_ project: Project) {
        let heading = cache[project].map(GitHeadingStatus.init)
        guard headings[project] != heading else { return }
        headings[project] = heading
        for observer in headingObservers.values { observer.yield(headings) }
    }
    private func removeHeadingObserver(_ id: UUID) {
        headingObservers.removeValue(forKey: id)
    }
    private func setInterest(_ checkouts: Set<Project>, id: UUID) {
        if checkouts.isEmpty { interests.removeValue(forKey: id) } else { interests[id] = checkouts }
        let next = interests.values.reduce(into: Set<Project>()) { $0.formUnion($1) }
        let dropped = interested.subtracting(next)
        interested = next
        // Nothing waits on a refresh nobody shows any more.
        let observed = Set(sessions.values)
        for project in dropped where !observed.contains(project) { cancelWork(project) }
    }
    private func cancelWork(_ project: Project) {
        timers.removeValue(forKey: project)?.cancel()
        refreshes.removeValue(forKey: project)?.cancel()
        refreshAgain.remove(project)
    }
    private func debouncedRefresh(sessionId: String, project: Project) async {
        timers.removeValue(forKey: project)
        if sessions[sessionId] != nil {
            await refresh(sessionId: sessionId)
        } else if interested.contains(project) {
            await fetch(sessionId: sessionId, project: project)
        }
    }
    private func removeObserver(sessionId: String, id: UUID) {
        observers[sessionId]?.removeValue(forKey: id)
        if observers[sessionId]?.isEmpty == true { stop(sessionId: sessionId) }
    }
}
