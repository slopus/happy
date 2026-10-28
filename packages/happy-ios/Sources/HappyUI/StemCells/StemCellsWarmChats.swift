#if canImport(UIKit)
import HappyCore
import Network
import UIKit

/// The conversations a paired computer's phone reads ahead and keeps, so
/// one opened from the sidebar shows its transcript, laid out, on the
/// push's first frame (`StemCellsWarmth` holds desktop's rules).
///
/// Each kept conversation follows the store's stream like an open one, so
/// it is current when opened. Rows are laid out off the main thread for
/// the few likeliest. Reads stop in the background and under memory
/// pressure; Low Data Mode, Low Power Mode and a hot phone read only the
/// top few, and nothing on a finger's intent.
@MainActor
final class StemCellsWarmChats {
    /// One conversation read and kept, and the screens showing it.
    final class Chat {
        let agentId: String
        let conversation: StemCellConversation
        fileprivate(set) var planner: StemCellChatPlanner
        /// Its newest state, as the conversation last said.
        fileprivate(set) var snapshot = StemCellChatSnapshot()
        /// Rows laid out ahead, for these items at this key.
        fileprivate(set) var plans: (items: [StemCellChatItem], key: StemCellChatPlanner.Key, plans: [ChatRowPlan])?
        fileprivate var watchers: [UUID: (StemCellChatSnapshot) -> Void] = [:]
        fileprivate var following: Task<Void, Never>?
        fileprivate var planning: Task<Void, Never>?
        fileprivate var left: Int?
        fileprivate var intent: Int?

        fileprivate init(agentId: String, conversation: StemCellConversation, planner: StemCellChatPlanner) {
            self.agentId = agentId
            self.conversation = conversation
            self.planner = planner
        }

        /// Rows laid out ahead for exactly these items at this key.
        func plans(for items: [StemCellChatItem], key: StemCellChatPlanner.Key) -> [ChatRowPlan]? {
            guard let plans, plans.items == items, plans.key == key else { return nil }
            return plans.plans
        }

        /// Rows its screen laid out, as they stand untouched (nothing
        /// copied, opened or proposed): kept for the next open.
        func keep(_ plans: [ChatRowPlan], items: [StemCellChatItem], key: StemCellChatPlanner.Key) {
            self.plans = (items, key, plans)
        }
    }

    /// Off for a measured "before": every open reads cold, as it used to.
    static let enabled = ProcessInfo.processInfo.environment["STEM_WARM"] != "0"

    private let client: DirectAgentClient
    private let store: StemCellsStore
    private let persistence: DirectSyncEngine?
    private let syntax: CodeSyntaxService
    private var chats: [String: Chat] = [:]
    private var candidates: [StemCellsWarmth.Candidate] = []
    private var visible = Set<String>()
    /// The last left first.
    private var leftOrder: [String] = []
    private var clock = 0
    private var ranked: [String] = []
    /// What rows are laid out at: the sidebar's width and text, which a
    /// pushed conversation has too.
    private var layout: (width: CGFloat, environment: TextEnvironment?)?
    private var references = StemCellReferences()
    private var pump: Task<Void, Never>?
    private var started = false
    private var background = false
    /// A memory warning came: only the top few from then on.
    private var pressed = false
    private var constrainedNetwork = false
    private let path = NWPathMonitor()
    private var observers: [NSObjectProtocol] = []
    private let budget = StemCellsWarmth.laidOut(physicalMemory: ProcessInfo.processInfo.physicalMemory)

    /// When a row was tapped, for its screen to time how soon it showed.
    private var tapped: (agentId: String, at: CFTimeInterval)?

    init(client: DirectAgentClient, store: StemCellsStore, syntax: CodeSyntaxService, persistence: DirectSyncEngine? = nil) {
        self.client = client
        self.store = store
        self.persistence = persistence
        self.syntax = syntax
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.enterBackground() }
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.enterForeground() }
        })
        observers.append(center.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.memoryWarning() }
        })
        for name in [Notification.Name.NSProcessInfoPowerStateDidChange, ProcessInfo.thermalStateDidChangeNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.rerank() }
            })
        }
        path.pathUpdateHandler = { [weak self] path in
            let constrained = path.isConstrained
            Task { @MainActor in
                guard let self, self.constrainedNetwork != constrained else { return }
                self.constrainedNetwork = constrained
                self.rerank()
            }
        }
        path.start(queue: DispatchQueue(label: "StemCellsWarmChats.path", qos: .utility))
    }

    isolated deinit {
        pump?.cancel()
        easing?.cancel()
        path.cancel()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        for chat in chats.values { stop(chat) }
    }

    /// Low Data Mode, Low Power Mode, a hot phone or a memory warning.
    private var constrained: Bool {
        let thermal = ProcessInfo.processInfo.thermalState
        return constrainedNetwork || pressed || ProcessInfo.processInfo.isLowPowerModeEnabled || thermal == .serious || thermal == .critical
    }

    private var limit: Int { constrained ? StemCellsWarmth.Limits.constrained : StemCellsWarmth.Limits.preloaded }

    // MARK: What the sidebar says

    /// The sidebar's rows and which of them are on screen.
    func update(rows: [StemCellsRow], visible: [StemCellsRow], references: StemCellReferences) {
        let next = StemCellsWarmth.candidates(rows)
        let shown = Set(visible.compactMap(\.agentId))
        let referencesChanged = references != self.references
        self.references = references
        guard next != candidates || shown != self.visible || referencesChanged || !started else { return }
        candidates = next
        self.visible = shown
        if !started {
            started = true
            // After the sidebar's first paint, and an open made meanwhile.
            schedule(after: StemCellsWarmth.Limits.delay)
        }
        rerank()
    }

    /// What rows are laid out at, from the sidebar's own size and text.
    func layOut(width: CGFloat, environment: TextEnvironment?) {
        guard width > 0, layout?.width != width || layout?.environment != environment else { return }
        layout = (width, environment)
        replanAll()
    }

    /// A finger came down on a row: read it now, as desktop does on a hover.
    func intent(_ agentId: String) {
        guard Self.enabled, !background, !constrained || ranked.contains(agentId) else { return }
        clock += 1
        let chat = chats[agentId] ?? begin(agentId)
        chat.intent = clock
        prune()
        replanAll()
    }

    /// A row was tapped: when, for its screen's timing.
    func tap(_ agentId: String) {
        tapped = (agentId, CACurrentMediaTime())
    }

    /// When the row of the screen opening now was tapped, once.
    func takeTap(_ agentId: String) -> CFTimeInterval? {
        defer { tapped = nil }
        return tapped?.agentId == agentId ? tapped?.at : nil
    }

    // MARK: Screens

    /// The conversation for a screen about to show it, read ahead or
    /// started now, kept while the screen holds it. Hand it back with
    /// `release`. Rows being laid out ahead go on: the screen takes them
    /// from the same planner.
    func hold(_ agentId: String) -> (chat: Chat, token: UUID) {
        let chat = chats[agentId] ?? begin(agentId)
        let token = UUID()
        chat.watchers[token] = { _ in }
        return (chat, token)
    }

    /// `watch` hears every snapshot of a held conversation from now on.
    func watch(_ chat: Chat, token: UUID, _ watch: @escaping (StemCellChatSnapshot) -> Void) {
        guard chat.watchers[token] != nil else { return }
        chat.watchers[token] = watch
    }

    /// A screen is done with it: kept as left, if it was opened, else as
    /// it was (a preview); gone, if it was put away.
    func release(_ chat: Chat, token: UUID, opened: Bool, putAway: Bool = false) {
        chat.watchers.removeValue(forKey: token)
        guard chats[chat.agentId] === chat else { return }
        if putAway {
            leftOrder.removeAll { $0 == chat.agentId }
            candidates.removeAll { $0.agentId == chat.agentId }
        }
        if !Self.enabled || putAway, chat.watchers.isEmpty {
            stop(chat)
            chats.removeValue(forKey: chat.agentId)
            return
        }
        if opened {
            clock += 1
            chat.left = clock
            leftOrder.removeAll { $0 == chat.agentId }
            leftOrder.insert(chat.agentId, at: 0)
            if leftOrder.count > StemCellsWarmth.Limits.released * 2 { leftOrder.removeLast() }
        }
        rerank()
    }

    // MARK: Ranking and reading

    private func rerank() {
        ranked = Self.enabled && !background ? StemCellsWarmth.ranked(candidates, left: leftOrder, visible: visible, limit: limit) : []
        prune()
        replanAll()
        if started, pump == nil, !background { schedule(after: .zero) }
    }

    /// Drops what desktop's limits don't keep.
    private func prune() {
        let kept = chats.values.map { StemCellsWarmth.Kept(agentId: $0.agentId, held: !$0.watchers.isEmpty, left: $0.left, intent: $0.intent) }
        let stays = StemCellsWarmth.retained(kept, wanted: ranked, prefetched: constrained ? 0 : StemCellsWarmth.Limits.prefetched)
        for (id, chat) in chats where !stays.contains(id) {
            stop(chat)
            chats.removeValue(forKey: id)
        }
    }

    /// Reads the ranking's conversations one at a time, each once nothing
    /// a person opened is still loading (`preloadRecentSessions`).
    private func schedule(after delay: Duration) {
        guard Self.enabled else { return }
        pump?.cancel()
        pump = Task { [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            while !Task.isCancelled {
                guard let self, !self.background else { return }
                if self.chats.values.contains(where: { !$0.watchers.isEmpty && !$0.snapshot.loaded }) {
                    try? await Task.sleep(for: StemCellsWarmth.Limits.busyWait)
                    continue
                }
                guard let next = self.ranked.first(where: { self.chats[$0] == nil }) else {
                    self.pump = nil
                    return
                }
                let chat = self.begin(next)
                self.replanAll()
                // One read at a time; one that never answers is left to finish alone.
                let deadline = ContinuousClock.now + .seconds(10)
                while !Task.isCancelled, self.chats[next] === chat, !chat.snapshot.loaded, ContinuousClock.now < deadline {
                    try? await Task.sleep(for: StemCellsWarmth.Limits.busyWait)
                }
            }
        }
    }

    private func begin(_ agentId: String) -> Chat {
        let conversation = StemCellConversation(client: client, store: store, agentId: agentId, persistence: persistence)
        let chat = Chat(agentId: agentId, conversation: conversation, planner: StemCellChatPlanner(syntax: syntax))
        chats[agentId] = chat
        let updates = conversation.updates
        chat.following = Task { [weak self, weak chat] in
            for await snapshot in updates {
                guard let self, let chat else { return }
                chat.snapshot = snapshot
                for watcher in chat.watchers.values { watcher(snapshot) }
                if chat.watchers.isEmpty { self.replan(chat) }
            }
        }
        Task { await conversation.start() }
        return chat
    }

    private func stop(_ chat: Chat) {
        chat.following?.cancel()
        chat.planning?.cancel()
        let conversation = chat.conversation
        Task { await conversation.stop() }
    }

    // MARK: Laying out ahead

    private var planned = Set<String>()

    private func replanAll() {
        let kept = chats.values.map { StemCellsWarmth.Kept(agentId: $0.agentId, held: !$0.watchers.isEmpty, left: $0.left, intent: $0.intent) }
        let budget = min(budget, limit)
        planned = Set(StemCellsWarmth.planned(kept, ranked: ranked, budget: background ? 0 : budget))
        for chat in chats.values where chat.watchers.isEmpty { replan(chat) }
    }

    /// Lays out a kept conversation's rows off the main thread, as its
    /// screen would on opening; one outside the budget lets its rows go.
    private func replan(_ chat: Chat) {
        guard planned.contains(chat.agentId) else {
            if chat.plans != nil {
                chat.planning?.cancel()
                chat.plans = nil
                chat.planner = StemCellChatPlanner(syntax: syntax)
            }
            return
        }
        guard let layout, chat.snapshot.loaded, chat.watchers.isEmpty else { return }
        var references = references
        references.subagents = chat.snapshot.subagentTitles
        let key = StemCellChatPlanner.Key(width: layout.width, maxContentWidth: ContentWidth.maxWidth, environment: layout.environment, references: references, subagentTitles: chat.snapshot.subagentTitles)
        let items = chat.snapshot.items
        if chat.plans?.items == items, chat.plans?.key == key { return }
        chat.planning?.cancel()
        let planner = chat.planner
        chat.planning = Task { [weak chat] in
            let plans = await planner.plans(items, key: key, copied: nil)
            guard !Task.isCancelled, let chat else { return }
            chat.plans = (items, key, plans)
        }
    }

    // MARK: The phone's state

    /// Nothing is read or kept in the background but what is on screen:
    /// coming back, the store reads every conversation still following it
    /// again at once, and the rest are read one at a time after the delay.
    private func enterBackground() {
        background = true
        pump?.cancel(); pump = nil
        dropUnheld()
    }

    private func enterForeground() {
        background = false
        pressed = false
        rerank()
        if started { schedule(after: StemCellsWarmth.Limits.delay) }
    }

    /// Everything not on screen goes, and only the top few are read again
    /// for a while.
    private func memoryWarning() {
        pressed = true
        pump?.cancel(); pump = nil
        dropUnheld()
        rerank()
        easing?.cancel()
        easing = Task { [weak self] in
            try? await Task.sleep(for: .seconds(120))
            guard !Task.isCancelled, let self else { return }
            self.pressed = false
            self.rerank()
        }
    }

    private var easing: Task<Void, Never>?

    private func dropUnheld() {
        for (id, chat) in chats where chat.watchers.isEmpty {
            stop(chat)
            chats.removeValue(forKey: id)
        }
    }

    /// The computer was unpaired: nothing more is read from it.
    func stopAll() {
        pump?.cancel(); pump = nil
        easing?.cancel(); easing = nil
        started = false
        for chat in chats.values { stop(chat) }
        chats.removeAll()
    }
}
#endif
