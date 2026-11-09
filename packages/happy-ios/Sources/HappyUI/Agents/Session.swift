#if canImport(UIKit)
import HappyCore
import UIKit

/// One paired computer's V2, shared by every screen that shows it:
/// the store, the client its conversations use, and the pictures it has
/// read. The store's snapshots arrive here off the main thread's work and
/// are handed to whoever watches.
@MainActor
final class Session {
    let accountID: String
    private(set) var computerName: String
    /// The installation's health `instanceId`: what a link copied out of
    /// Happy names (`happy://<instanceId>/…`). Nil for an older daemon,
    /// which gets no such link.
    private(set) var instanceId: String?
    /// A Happy Cloud server's: its Chief of Staff can be renamed but never
    /// archived, and it reads onboarding, the person's permissions and
    /// what each vault lets them do (`followCloud`).
    let isCloud: Bool
    /// The team server's origin; nil for a paired computer.
    let server: String?
    /// What it set up for, kept so a screen inside a conversation can
    /// open Settings.
    private(set) weak var context: AppContext?
    /// What the server still wants of the person (`GET /v0/onboarding`),
    /// read on a cloud server only, and again on the events it names; nil
    /// until read.
    private(set) var onboarding: Onboarding?
    private var onboardingWatchers: [UUID: (Onboarding?) -> Void] = [:]
    private var cloudFollowing: Task<Void, Never>?
    /// What the person's role lets them do on a cloud server; nil until
    /// read, and kept nil if the read fails, so `gate` shows nothing it
    /// would refuse.
    private(set) var permissions: Permissions?
    /// What each vault lets the person do, by Surface ID (cloud only).
    private(set) var vaultAccesses: [String: VaultAccess] = [:]
    private var accessWatchers: [UUID: () -> Void] = [:]
    /// What the controls a role decides follow: a computer gates nothing.
    var gate: RoleGate { isCloud ? .cloud(permissions) : .open }
    let engine: SyncEngine
    let client: AgentClient
    let store: Store
    let images: Images
    /// The models the composer's pickers offer.
    let models: ModelState
    /// What new work starts on: the person's preferences on this computer
    /// (`ModelPreferences`) over its catalog; nil until the catalog is read.
    var newWorkMode: AgentWire.Mode? { models.catalog?.startMode(ModelPreferences(home.settings)) }
    /// What this computer last showed, for opening on it offline.
    let offline: OfflineFile?
    /// The pictures, recordings and files its conversations showed, kept
    /// on this phone for good (`MediaLibrary`).
    let media: MediaLibrary?
    /// The composers' drafts, kept on this phone beside the computer's copy.
    let drafts: Drafts
    /// Colours the code blocks its conversations show.
    let syntax = CodeSyntaxService()
    /// Builds and colours the diffs its tool calls and workspaces show.
    let diffDocuments = DiffDocumentCache()
    let diffSyntax = DiffSyntaxService()
    /// The conversations read ahead and kept, so they open drawn.
    let warm: WarmChats
    /// The person's settings for this phone.
    let localSettings: LocalSettings
    /// What this computer's placeholder picture is picked by, when it has
    /// none of its own (`AvatarPlaceholder`).
    let placeholderSeed: String
    /// What the person's own placeholder is picked by (`PersonSeed`): their
    /// team user once the computer says it is in a team, else this
    /// computer's seed as theirs.
    var personSeed: String { PersonSeed.seed(userId: home.userId, otherwise: "person:" + placeholderSeed) }
    /// The person's own name and picture on this computer.
    var profile: ProfileSource {
        if let madeProfile { return madeProfile }
        let source = ProfileSource(client: client, engine: engine, placeholderSeed: personSeed)
        madeProfile = source
        return source
    }
    private var madeProfile: ProfileSource?
    private(set) var snapshot = Snapshot()
    private var watchers: [UUID: (Snapshot) -> Void] = [:]
    /// Readable, not settable, so a test can say the follow was let go of
    /// rather than take `stop`'s word for it.
    private(set) var following: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    private var connectionObservation: AccountsObservation?
    private var connectionFollowing: Task<Void, Never>?
    /// What home lists for this computer (`SidebarRows`), as it last came.
    private(set) var home = HomeSnapshot()
    private var homeWatchers: [UUID: (HomeSnapshot) -> Void] = [:]
    private var connectionStatus: ConnectionStatus = .connecting
    /// Whether the phone has a way out at all (`NetworkPath`).
    private var networkPath = NetworkPath.shared.isSatisfied
    private var networkWatch: NetworkPathWatch?
    /// The link as it is (`headerState(status:snapshot:network:)`), and as
    /// headers show it: home's title and every chat's subtitle watch
    /// `link` (`watchHeader`), so they change together, debounced.
    private(set) var headerState: Strings.HeaderStatus.State = .connecting
    let link = LinkIndicator(wanted: .connecting)

    /// The notifications this session watches for, for the same reason.
    /// Nothing adds to it today; it is emptied by `stop` all the same, so
    /// that anything added later is covered by the same teardown.
    var watchedCount: Int { observers.count }

    private static var sessions: [String: Session] = [:]

    /// The session for a paired computer, made once and kept while the app runs.
    static func session(for accountID: String, context: AppContext) -> Session? {
        guard let engine = context.account.agentConnections.syncEngine(for: accountID) else {
            // A server signed out of: what was kept of it goes too.
            if sessions[accountID] != nil, context.account.agentConnections.signedOut(accountID) { forget(accountID) }
            return nil
        }
        if let existing = sessions[accountID] {
            if existing.engine === engine { return existing }
            // The same computer on a new engine. The old session's engine
            // is gone, so nothing it watches can say anything again: it is
            // stopped here rather than left to whenever the last screen
            // holding it is freed.
            existing.stop()
        }
        let session = Session(accountID: accountID, engine: engine, account: context.account)
        session.context = context
        sessions[accountID] = session
        return session
    }

    /// Forgets a computer that was unpaired, and what was kept of it — that
    /// computer's and nobody else's, since another may still be paired.
    ///
    /// A document previewed from it is not among them: preview files are
    /// not filed by computer, so there is no telling them apart. An open
    /// preview removes its own file when it closes, and what a crash left
    /// behind goes before the first preview of the next launch
    /// (`FilePreview`), so until then such leftovers stay in this app's
    /// caches.
    static func forget(_ accountID: String) {
        MediaLibrary.forget(namespace: "agent/\(accountID)")
        // Its folder can hold a large media cache: deleted off the main thread.
        Task.detached(priority: .utility) { OfflineFile.remove(accountID) }
        guard let session = sessions.removeValue(forKey: accountID) else { return }
        session.stop()
        // The store belongs to the engine, not to the session, so only an
        // unpairing stops it.
        let store = session.store
        Task { await store.stop() }
    }

    /// What this session set going, stopped: the snapshots followed and
    /// the conversations read ahead, with the path monitor and the
    /// notifications `WarmChats` watches. Twice does nothing the second
    /// time, and a screen still holding the session simply stops hearing.
    func stop() {
        following?.cancel()
        following = nil
        cloudFollowing?.cancel()
        cloudFollowing = nil
        connectionFollowing?.cancel()
        connectionFollowing = nil
        connectionObservation?.cancel()
        connectionObservation = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        warm.stop()
    }

    private init(accountID: String, engine: SyncEngine, account: AccountController) {
        media = MediaLibrary.agent(accountID)
        self.accountID = accountID
        computerName = account.agentConnections.accounts.first { $0.id == accountID }?.name ?? Strings.agentConnection
        instanceId = account.agentConnections.accounts.first { $0.id == accountID }?.instanceId
        placeholderSeed = account.agentConnections.placeholderSeed(for: accountID) ?? accountID
        server = account.agentConnections.server(for: accountID)
        isCloud = HappyCloud.isCloud(server)
        self.engine = engine
        self.localSettings = account.localSettings
        let client = engine.client
        self.client = client
        let offline = engine.offline
        self.offline = offline
        Task.detached(priority: .utility) { OfflineFile.removeLegacy(accountID) }
        store = engine.spaces
        images = Images(client: client, offline: offline)
        warm = WarmChats(client: client, store: store, syntax: syntax, persistence: engine)
        warm.server = server
        warm.instanceId = instanceId
        models = ModelState(client: client, offline: offline, store: store, cloud: isCloud)
        drafts = Drafts(offline: offline)
        models.load()
        let updates = store.updates
        following = Task { [weak self] in
            for await snapshot in updates {
                guard let self else { return }
                // Back after a gap: the pictures it couldn't read then.
                if snapshot.live, !self.snapshot.live { images.retryFailed(); reconnected() }
                self.snapshot = snapshot
                for watcher in self.watchers.values { watcher(snapshot) }
            }
        }
        networkWatch = NetworkPath.shared.watch { [weak self, engine] satisfied in
            MainActor.assumeIsolated {
                guard let self else { return }
                let back = satisfied && !self.networkPath
                self.networkPath = satisfied
                self.updateHeaderState()
                // Back from airplane mode: reconnect, and send what waited, now.
                if back { Task { await engine.reconnect() } }
            }
        }
        connectionObservation = account.observeAccounts { [weak self, weak account] _ in
            guard let self, let account else { return }
            computerName = account.agentConnections.accounts.first { $0.id == accountID }?.name ?? computerName
            instanceId = account.agentConnections.accounts.first { $0.id == accountID }?.instanceId
            warm.instanceId = instanceId
            receive(status: account.agentConnections.accounts.first { $0.id == accountID }?.status ?? .paused)
        }
        connectionFollowing = Task { [weak self, engine] in
            for await snapshot in await engine.snapshots() {
                guard !Task.isCancelled, let self else { return }
                receive(home: snapshot)
            }
        }
        if isCloud { followCloud() }
        // AgentConnections owns foreground/background and account switching.
        // Opening an offscreen account's settings never starts another stream.
    }

    /// What a cloud server says of the person, read at once and again on
    /// each event that may change it: onboarding (`Onboarding.refreshEvents`),
    /// permissions (`role.*`), and the vaults' access (`surface.*`,
    /// `vault.settings.updated`); everything on a resync. A role changed at
    /// the accounts service lands with the next token, so a reconnect
    /// reads the permissions again too (`reconnected`).
    private func followCloud() {
        let store = store
        cloudFollowing = Task { [weak self] in
            let events = await store.events(matching: Onboarding.refreshEvents + Permissions.refreshEvents + ["surface.", "vault.settings.updated"])
            self?.read([.onboarding, .permissions, .vaults])
            for await event in events {
                guard !Task.isCancelled, let self else { return }
                guard case .event(let envelope) = event, let type = envelope["type"]?.stringValue else {
                    read([.onboarding, .permissions, .vaults])
                    continue
                }
                var parts: Set<CloudPart> = []
                if Onboarding.refreshEvents.contains(where: { type == $0 || ($0.hasSuffix(".") && type.hasPrefix($0)) }) { parts.insert(.onboarding) }
                if Permissions.refreshEvents.contains(where: { type == $0 || ($0.hasSuffix(".") && type.hasPrefix($0)) }) { parts.insert(.permissions) }
                if type.hasPrefix("surface.") || type == "vault.settings.updated" { parts.insert(.vaults) }
                read(parts)
            }
        }
    }

    private enum CloudPart { case onboarding, permissions, vaults }
    /// A protected settings page gaining focus checks current grants.
    func refreshPermissions() {
        guard isCloud else { return }
        read([.permissions])
    }
    /// One read of each part at a time; asked again meanwhile, it reads
    /// once more when that lands.
    private var reading: Set<CloudPart> = []
    private var readAgain: Set<CloudPart> = []

    private func reconnected() {
        guard isCloud else { return }
        read([.permissions, .vaults])
    }

    private func read(_ parts: Set<CloudPart>) {
        let client = client
        for part in parts {
            guard !reading.contains(part) else { readAgain.insert(part); continue }
            reading.insert(part)
            Task { [weak self] in
                switch part {
                case .onboarding:
                    let read = try? await client.onboarding()
                    if let read, read != self?.onboarding { self?.adopt(read) }
                case .permissions:
                    // A failed read keeps what was read: a dropped link
                    // isn't a role taken away, and nothing is shown it
                    // never had.
                    if let read = try? await client.permissions(), read != self?.permissions { self?.adopt(read) }
                case .vaults:
                    if let surfaces = (try? await client.surfaces()) ?? nil { self?.adopt(vaults: surfaces) }
                }
                guard let self else { return }
                reading.remove(part)
                if readAgain.remove(part) != nil { read([part]) }
            }
        }
    }

    /// The team's role names by ID (`GET /v0/roles`, cloud only), read
    /// once, as desktop and Android read them; a read that fails is nil
    /// and asked again next time.
    private var roleNames: [String: String]?

    func teamRoleNames() async -> [String: String]? {
        if let roleNames { return roleNames }
        guard isCloud, let roles = try? await client.teamRoles() else { return nil }
        let names = Dictionary(roles.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        roleNames = names
        return names
    }

    private func adopt(_ onboarding: Onboarding) {
        self.onboarding = onboarding
        for watcher in onboardingWatchers.values { watcher(onboarding) }
    }

    private func adopt(_ permissions: Permissions) {
        self.permissions = permissions
        for watcher in accessWatchers.values { watcher() }
    }

    private func adopt(vaults surfaces: [AgentWire.Surface]) {
        let next = Dictionary(surfaces.filter { $0.type == "vault" }.map { ($0.id, $0.vaultAccess) }, uniquingKeysWith: { first, _ in first })
        guard next != vaultAccesses else { return }
        vaultAccesses = next
        for watcher in accessWatchers.values { watcher() }
    }

    /// What `surfaceId`'s vault lets the person do. On a cloud server, one
    /// not yet read is read-only, never locked: it opens, and offers no
    /// change it may be refused.
    func vaultAccess(_ surfaceId: String) -> VaultAccess {
        guard isCloud else { return VaultAccess() }
        return vaultAccesses[surfaceId] ?? VaultAccess(level: .read)
    }

    /// Calls `watch` whenever the permissions or a vault's access change.
    func watchAccess(_ watch: @escaping () -> Void) -> Watch {
        let id = UUID()
        accessWatchers[id] = watch
        return Watch { [weak self] in self?.accessWatchers.removeValue(forKey: id) }
    }

    /// Calls `watch` with onboarding as it is and as it changes.
    func watchOnboarding(_ watch: @escaping (Onboarding?) -> Void) -> Watch {
        let id = UUID()
        onboardingWatchers[id] = watch
        watch(onboarding)
        return Watch { [weak self] in self?.onboardingWatchers.removeValue(forKey: id) }
    }

    /// Calls `watch` with every snapshot from now on, starting with the current one.
    func watch(_ watch: @escaping (Snapshot) -> Void) -> Watch {
        let id = UUID()
        watchers[id] = watch
        watch(snapshot)
        return Watch { [weak self] in self?.watchers.removeValue(forKey: id) }
    }

    /// No link is ever offline: one not connected is asked again with
    /// backoff for as long as it is there, so it is connecting, whatever
    /// kept it away. What is not the network's to fix (a pairing to redo, a
    /// sign-in that ended) home's notice says, in its own words.
    static func headerState(status: ConnectionStatus, snapshot: HomeSnapshot, network: Bool = true) -> Strings.HeaderStatus.State {
        // No way out at all: nothing to connect to yet, whatever was last heard.
        if !network { return .waitingForNetwork }
        // The stream is open: it is the truth, whatever the pairing's own
        // check (which retries on its own backoff) last said.
        if snapshot.live { return snapshot.loaded && !snapshot.syncing ? .online : .syncing }
        // The pairing answered and the stream isn't open yet: catching up,
        // unless the stream is on its way back or stopped for a reason.
        if status == .connected, !snapshot.reconnecting, snapshot.error == nil { return .syncing }
        return .connecting
    }

    private func updateHeaderState() {
        let next = Self.headerState(status: connectionStatus, snapshot: home, network: networkPath)
        guard next != headerState else { return }
        headerState = next
        link.want(next)
    }

    /// The pairing's own check, as `AgentConnections` says it (or a test).
    func receive(status: ConnectionStatus) {
        connectionStatus = status
        updateHeaderState()
    }

    /// What home lists, now and as it changes: the rows a screen finds its
    /// chat's among, as home draws them.
    func watchHome(_ watch: @escaping (HomeSnapshot) -> Void) -> Watch {
        let id = UUID()
        homeWatchers[id] = watch
        watch(home)
        return Watch { [weak self] in self?.homeWatchers.removeValue(forKey: id) }
    }

    /// A snapshot from the engine (or a test standing in for it).
    func receive(home snapshot: HomeSnapshot) {
        if snapshot.live, !home.live { images.retryFailed(); reconnected() }
        home = snapshot
        madeProfile?.placeholderSeed = personSeed
        updateHeaderState()
        for watch in homeWatchers.values { watch(snapshot) }
    }

    /// What headers show of the link, now and on every change (`link`).
    func watchHeader(_ watch: @escaping (Strings.HeaderStatus.State) -> Void) -> Watch {
        link.watch(watch)
    }
}

/// Stops watching at `invalidate`, or when it is let go of, whichever comes
/// first, and exactly once. The cancel always runs on the main actor.
///
/// Not `isolated deinit`. That aborts on the iOS 26.3 simulator runtime
/// whenever a screen holding one is freed: libmalloc's "pointer being freed
/// was not allocated", in `TaskLocal::StopLookupScope::~StopLookupScope`
/// under `swift_task_deinitOnExecutor`. It is the runtime's hop to the
/// actor that fails, not this code: clean main (829dab29f) aborts the same
/// way, and the same build is fine on 26.5. Whether a 26.3 device does it
/// too is untested; this avoids the hop either way.
///
/// A `@MainActor` class does not promise its deinit runs on the main actor:
/// the last reference can go anywhere, so the deinit says where it is.
@MainActor
final class Watch {
    private var cancel: (@MainActor @Sendable () -> Void)?

    init(_ cancel: @escaping @MainActor @Sendable () -> Void) { self.cancel = cancel }

    func invalidate() {
        // Taken before it is called, so a cancel that lets this watch go
        // (`deinit` below) finds nothing left to call.
        let cancel = cancel
        self.cancel = nil
        cancel?()
    }

    /// Nonisolated, and the only thing left holding the object, so reading
    /// the cancel races with nothing. The cancel itself is `Sendable` and
    /// main-actor, and it never names the watch, so handing it on is safe.
    deinit {
        guard let cancel else { return }
        if Thread.isMainThread {
            MainActor.assumeIsolated { cancel() }
        } else {
            DispatchQueue.main.async { cancel() }
        }
    }
}
#endif
