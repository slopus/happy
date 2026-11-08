#if canImport(UIKit)
import HappyAnalytics
import HappyCore
import UIKit

/// A call's tools and context over one agent connection: its sidebar for
/// the directory, its kept conversations (`WarmChats`) for what they say,
/// and the conversation's own send, which the composer uses too but which
/// here leaves the composer's draft and attachments alone. New work is
/// compose's own (`NewTask`), started off screen with a conversation of
/// its own that the call's first message makes, or compose's screen in
/// front; the
/// model and effort the composer's pickers' (`ModelCatalog.select`,
/// `Conversation.setMode`). On a team, who wrote each message is named as
/// the computer names its members (`TeamUser`).
@MainActor
final class SessionCallTargets: CallTargets {
    private let session: Session
    private weak var shell: ShellViewController?
    /// Conversations the call follows, held so they stay read.
    private var held: [String: (chat: WarmChats.Chat, token: UUID)] = [:]
    /// New work's screens the call has seen, until their first message makes them.
    private var drafts: [String: Weak] = [:]
    private struct Weak { weak var chat: ChatViewController? }
    /// New work the call started, off screen: its conversation, which its
    /// first message makes, as a screen's would. Unsent only while that
    /// message is on its way; refused, it is discarded.
    private var started: [String: Started] = [:]
    @MainActor private final class Started {
        let task: NewTask
        let conversation: Conversation
        var snapshot = ChatSnapshot()
        var sent = false
        var reading: Task<Void, Never>?

        init(task: NewTask, conversation: Conversation) {
            self.task = task
            self.conversation = conversation
        }
    }
    /// Team members' names by user ID, once the computer has given them;
    /// those asked for already, named or not.
    private var names: [String: String] = [:]
    private var asked: Set<String> = []
    /// A followed conversation changed.
    var onChange: ((CallTargetState) -> Void)?
    /// Ended with its call: nothing is held, opened or sent after.
    private var closed = false

    init(session: Session, shell: ShellViewController?) {
        self.session = session
        self.shell = shell
    }

    func close() {
        closed = true
        for (_, hold) in held { session.warm.release(hold.chat, token: hold.token, opened: false) }
        held.removeAll()
        for started in started.values {
            started.reading?.cancel()
            let task = started.task, conversation = started.conversation, sent = started.sent
            Task.detached {
                // A first message on its way makes its task and is handed
                // to the account's outbox before the conversation stops.
                if sent {
                    for _ in 0..<100 where !(await task.isMade) { try? await Task.sleep(for: .milliseconds(100)) }
                    try? await Task.sleep(for: .seconds(1))
                }
                await conversation.stop()
            }
        }
        started.removeAll()
        onChange = nil
    }

    /// Home's rows, then the spaces sidebar's, once each.
    private var allRows: [Row] { session.home.allRows + session.snapshot.allRows }

    /// Every conversation the rows open, in their order and nesting, once each.
    var rows: [CallTarget] { CallTarget.list(allRows) }

    private func target(_ agentId: String) -> CallTarget? {
        rows.first { $0.agentId == agentId }
    }

    func directory() async -> [CallTarget] { rows }

    func state(of agentId: String) async -> CallTargetState? {
        guard let target = target(agentId) else {
            if let started = started[agentId] {
                var state = CallTargetState.from(started.snapshot, target: Self.target(agentId, started.task.choice))
                // Empty until its first message: nothing to read, and it takes one.
                state.writable = started.snapshot.error == nil
                state.fresh = true
                return await named(await withModels(state, mode: started.snapshot.mode))
            }
            guard let draft = draftChat(agentId), let choice = draft.unmadeChoice else { return nil }
            var state = CallTargetState.from(draft.callSnapshot, target: Self.target(agentId, choice))
            // Empty until its first message: nothing to read, and it takes one.
            state.writable = draft.callSnapshot.error == nil
            state.fresh = true
            return await withModels(state, mode: draft.callMode)
        }
        let read: (CallTargetState, AgentWire.Mode?)? = await borrowing(agentId) { chat in
            guard await Self.loaded(chat) else { return nil }
            return (current(chat, target: target), chat.snapshot.mode)
        }
        guard let read else { return nil }
        return await named(await withModels(read.0, mode: read.1))
    }

    /// As opening it would: its kept chat held, a failed read asked for
    /// again (`Conversation.catchUp`), until the computer's history is in
    /// and the account's events stream is live, or `limit` runs out. Let go
    /// of after, it stays kept as a finger's reach keeps it (`borrowing`),
    /// following, so a read again soon finds it current. New work has
    /// nothing on the computer to read: as it is.
    func refreshed(_ agentId: String, within limit: Duration) async -> CallTargetState? {
        guard let target = target(agentId) else { return await state(of: agentId) }
        let deadline = ContinuousClock.now + limit
        let read: (CallTargetState, AgentWire.Mode?)? = await borrowing(agentId) { chat in
            var asked = ContinuousClock.now
            await chat.conversation.catchUp()
            while !isCurrent(chat), ContinuousClock.now < deadline, !Task.isCancelled, !closed {
                try? await Task.sleep(for: .milliseconds(50))
                // A read that failed meanwhile is asked for again, once a second at most.
                if ContinuousClock.now - asked >= .seconds(1) {
                    asked = ContinuousClock.now
                    await chat.conversation.catchUp()
                }
            }
            guard chat.snapshot.loaded else { return nil }
            return (current(chat, target: self.target(agentId) ?? target), chat.snapshot.mode)
        }
        guard let read else { return nil }
        return await named(await withModels(read.0, mode: read.1))
    }

    /// Read from the computer and following the account's live events.
    private func isCurrent(_ chat: WarmChats.Chat) -> Bool {
        chat.snapshot.synced && session.snapshot.live
    }

    /// `chat` as the call reads it, `fresh` only while it is current.
    private func current(_ chat: WarmChats.Chat, target: CallTarget) -> CallTargetState {
        var state = CallTargetState.from(chat.snapshot, target: target)
        state.fresh = isCurrent(chat)
        return state
    }

    /// `state` with who wrote each message said, the members it doesn't
    /// know yet asked for once (`GET /v0/users`). Outside a team no
    /// message has an author, and nothing is asked.
    private func named(_ state: CallTargetState) async -> CallTargetState {
        let me = session.home.userId
        let missing = state.authors.subtracting(names.keys).subtracting(asked).filter { $0 != me }
        if !missing.isEmpty {
            asked.formUnion(missing)
            if let users = try? await session.client.teamUsers(Array(missing)) {
                for user in users { names[user.id] = user.name }
            } else {
                // Asked again next time: until then they are "a teammate".
                asked.subtract(missing)
            }
        }
        return state.named(names, me: me)
    }

    /// `state` with the model its next message goes with (the
    /// conversation's, else what new work starts on) and the models the
    /// pickers offer, once the computer's are read: a second at most.
    private func withModels(_ state: CallTargetState, mode: AgentWire.Mode?) async -> CallTargetState {
        var state = state
        guard let catalog = await catalog() else { return state }
        state.models = CallModel.options(catalog)
        state.mode = (mode ?? session.newWorkMode).map { CallMode($0, catalog: catalog) }
        return state
    }

    /// The computer's models, asked for if they aren't here yet.
    private func catalog() async -> ModelCatalog? {
        if session.models.catalog == nil { session.models.load() }
        for _ in 0..<20 where session.models.catalog == nil && !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(50))
        }
        return session.models.catalog
    }

    /// New work as the call names it: its name, else the sidebar's
    /// "New Task" or "New Bot" until its first message names it.
    private static func target(_ agentId: String, _ choice: NewTask.Choice) -> CallTarget {
        let kind: CallTarget.Kind = choice.kind == .bot ? .bot : .task
        let name = CallTarget.clean(choice.name)
        return CallTarget(agentId: agentId, title: name.isEmpty ? (kind == .bot ? "New Bot" : "New Task") : name, kind: kind, status: .idle)
    }

    /// New work's screen under `agentId`, if one is on the stack and not made yet.
    private func draftChat(_ agentId: String) -> ChatViewController? {
        if let chat = drafts[agentId]?.chat, chat.unmadeChoice != nil { return chat }
        drafts[agentId] = nil
        guard let found = shell?.stack.compactMap({ $0 as? ChatViewController }).last(where: { $0.shownAgentId == agentId && $0.unmadeChoice != nil }) else { return nil }
        drafts[agentId] = Weak(chat: found)
        return found
    }

    func unlisted(_ agentId: String) async -> CallTarget? {
        guard target(agentId) == nil else { return nil }
        if let started = started[agentId] { return Self.target(agentId, started.task.choice) }
        guard let chat = draftChat(agentId), let choice = chat.unmadeChoice else { return nil }
        return Self.target(agentId, choice)
    }

    /// The app's kept chat for `agentId` while `use` runs: the call's own
    /// hold when it follows the conversation, else a hold of its own, let
    /// go of after, whatever else held it meanwhile. The chat is the one its
    /// screen shows, so what a send does shows there. Reached for first, as
    /// a finger on its row reaches (`WarmChats.intent`): let go of, it is
    /// kept as that one is, so a send after a read, or a read again, finds
    /// it read, or still reading, rather than a new one starting over.
    private func borrowing<T>(_ agentId: String, _ use: @MainActor (WarmChats.Chat) async -> T) async -> T {
        if let hold = held[agentId] { return await use(hold.chat) }
        session.warm.intent(agentId)
        let hold = session.warm.hold(agentId)
        let result = await use(hold.chat)
        session.warm.release(hold.chat, token: hold.token, opened: false)
        return result
    }

    /// Whether `chat` has its first page, waiting a bounded while as its
    /// screen would: about three seconds, less if the tool's time runs out first.
    private static func loaded(_ chat: WarmChats.Chat) async -> Bool {
        for _ in 0..<60 where !chat.snapshot.loaded && !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(50))
        }
        return chat.snapshot.loaded
    }

    func focused() async -> String? { focusedNow }

    var focusedNow: String? {
        (shell?.topViewController as? ChatViewController)?.shownAgentId
    }

    func open(_ agentId: String) async -> Bool {
        guard !closed, let shell else { return false }
        if target(agentId) == nil, let started = started[agentId] {
            // Nothing sent to it: there is nothing to show.
            guard started.sent else { return false }
            // Its first message is making it: its row comes once the computer has it.
            for _ in 0..<60 where target(agentId) == nil && !Task.isCancelled { try? await Task.sleep(for: .milliseconds(50)) }
        }
        guard let row = allRows.first(where: { $0.agentId == agentId && CallTarget.from($0) != nil }) else { return false }
        if focusedNow == agentId { return true }
        // Past the tool's deadline: nothing moves on screen.
        guard !Task.isCancelled else { return false }
        // Its row, where the person sees home, is pressed as they would.
        if let row = await homeInSight?.voiceTouchRow(agentId) { await VoiceTouch.play(row) }
        guard !Task.isCancelled, !closed else { return false }
        let chat = ChatViewController(session: session, agentId: agentId, title: row.label, spaceId: row.spaceId, intro: nil)
        await place(chat, in: shell)
        #if DEBUG
        print("[call] stack \(shell.stack.map { ($0 as? ChatViewController)?.shownAgentId ?? String(describing: type(of: $0)) })")
        #endif
        return true
    }

    /// New work as compose starts it (`NewTask`), chosen as the call asks,
    /// off screen: what is in front stays. Its conversation is the call's,
    /// for `send` to make it with its first message; on this computer and
    /// in no project, as compose makes it from any screen.
    func draft(_ kind: CallTarget.Kind, name: String) async -> CallTarget? {
        guard !closed else { return nil }
        let task = NewTask(client: session.client)
        task.choice = NewTask.Choice(kind: kind == .bot ? .bot : .task, name: name)
        let conversation = Conversation(client: session.client, store: session.store, agentId: task.agentId, newTask: task, mode: session.newWorkMode, persistence: session.engine)
        let started = Started(task: task, conversation: conversation)
        self.started[task.agentId] = started
        started.reading = Task { [weak started] in
            for await snapshot in conversation.updates { started?.snapshot = snapshot }
        }
        await conversation.start()
        return Self.target(task.agentId, task.choice)
    }

    func discard(_ agentId: String) async {
        guard let started = started[agentId], !started.sent else { return }
        self.started[agentId] = nil
        started.reading?.cancel()
        await started.conversation.stop()
    }

    /// Where `open` puts a screen: the main panel's root beside
    /// an empty panel, else in place of a conversation on top and over
    /// anything else. Returns once it has slid in, so the screen saying so
    /// comes before the next step does, never after it.
    private func place(_ chat: ChatViewController, in shell: ShellViewController) async {
        let navigation: UINavigationController = shell.isExpanded ? shell.main : shell.phone
        if shell.isExpanded, navigation.viewControllers.allSatisfy({ $0 === shell.placeholder }) {
            shell.showInMain(chat, animated: true)
        } else {
            // In place of a conversation on top; over anything else, which stays.
            let stack = CallNavigation.opening(chat, over: navigation.viewControllers) { $0 is ChatViewController }
            navigation.setViewControllers(stack, animated: true)
        }
        if let coordinator = chat.navigationController?.transitionCoordinator {
            await withCheckedContinuation { done in coordinator.animate(alongsideTransition: nil) { _ in done.resume() } }
        }
    }

    /// Back, as the person would: a sheet's own stack first, else what is
    /// presented closes, else the top screen goes. An alert waits for the
    /// person: the call never answers one.
    func back() async -> CallScreenMove {
        guard !closed, let shell else { return .refused("The call has ended.") }
        guard !Task.isCancelled else { return .refused("No answer in time.") }
        if let presented = Self.presented(over: shell) {
            if presented is UIAlertController { return .refused("An alert is open; the person answers it in the app.") }
            if let control = Self.backControl(in: shell) { await VoiceTouch.play(control) }
            if let sheet = presented as? UINavigationController, sheet.viewControllers.count > 1 {
                sheet.popViewController(animated: true)
                await Self.settle(sheet.transitionCoordinator)
            } else {
                await withCheckedContinuation { done in presented.dismiss(animated: true) { done.resume() } }
            }
            return .moved(atHome: Self.presented(over: shell) == nil && shell.stack.count == 1)
        }
        let stack = shell.stack
        guard stack.count > 1 else { return .refused("This is home; there is nothing to go back to.") }
        if let control = Self.backControl(in: shell) { await VoiceTouch.play(control) }
        shell.setStack(Array(shell.stack.dropLast()), animated: true)
        await Self.settle(shell.stackTransition)
        return .moved(atHome: shell.stack.count == 1)
    }

    /// Home, as the root of the stack: whatever is presented closes, and
    /// every screen over it goes.
    func home() async -> CallScreenMove {
        guard !closed, let shell else { return .refused("The call has ended.") }
        guard !Task.isCancelled else { return .refused("No answer in time.") }
        if let presented = Self.presented(over: shell) {
            if presented is UIAlertController { return .refused("An alert is open; the person answers it in the app.") }
            if let control = Self.backControl(in: shell) { await VoiceTouch.play(control) }
            await withCheckedContinuation { done in shell.dismiss(animated: true) { done.resume() } }
        } else if shell.stack.count > 1, let control = Self.backControl(in: shell) {
            await VoiceTouch.play(control)
        }
        let stack = shell.stack
        if stack.count > 1, let root = stack.first {
            shell.setStack([root], animated: true)
            await Self.settle(shell.stackTransition)
        }
        return .moved(atHome: true)
    }

    // MARK: Voice touch

    /// Home, where the person sees it now: nothing presented over it.
    private var homeInSight: AgentHomeViewController? {
        guard let shell, Self.presented(over: shell) == nil,
              let home = shell.stack.first as? AgentHomeViewController, home.isInSight else { return nil }
        return home
    }

    /// What the person taps to go back (`VoiceTouch`): a sheet's own back
    /// button, else its close, at the leading end where the app puts it;
    /// else the top screen's back button. Nil where there is none to see.
    private static func backControl(in shell: ShellViewController) -> VoiceTouch.Mark? {
        let isBack: (UIView) -> Bool = { VoiceTouch.holds($0, "BackButton") }
        if let presented = presented(over: shell) {
            guard let sheet = presented as? UINavigationController ?? presented.navigationController, !sheet.isNavigationBarHidden else { return nil }
            if sheet.viewControllers.count > 1 { return VoiceTouch.glass(in: sheet.navigationBar, where: isBack).map(VoiceTouch.glassMark) }
            guard sheet.topViewController?.navigationItem.leftBarButtonItem != nil else { return nil }
            let leftToRight = sheet.view.effectiveUserInterfaceLayoutDirection == .leftToRight
            let buttons = VoiceTouch.glassButtons(in: sheet.navigationBar).map { ($0, $0.convert($0.bounds, to: nil).midX) }
            let leading = leftToRight ? buttons.min { $0.1 < $1.1 } : buttons.max { $0.1 < $1.1 }
            return leading.map { VoiceTouch.glassMark($0.0) }
        }
        let navigation: UINavigationController = shell.isExpanded ? shell.main : shell.phone
        guard navigation.viewControllers.count > 1 else { return nil }
        return VoiceTouch.glass(in: navigation.navigationBar, where: isBack).map(VoiceTouch.glassMark)
    }

    /// The topmost screen presented over the app, if any. The call's own
    /// bar is a window of its own, never among them.
    private static func presented(over shell: ShellViewController) -> UIViewController? {
        var top = shell.presentedViewController
        while let next = top?.presentedViewController { top = next }
        return top.flatMap { $0.isBeingDismissed ? nil : $0 }
    }

    private static func settle(_ coordinator: (any UIViewControllerTransitionCoordinator)?) async {
        guard let coordinator else { return }
        await withCheckedContinuation { done in coordinator.animate(alongsideTransition: nil) { _ in done.resume() } }
    }

    func send(_ agentId: String, text: String, id: String, change: CallModeChange?) async -> CallSendOutcome {
        guard !closed else { return .refused("The call has ended.") }
        guard let target = target(agentId) else {
            // New work the call started: its conversation sends, and its first message makes it.
            if let started = started[agentId] {
                if started.snapshot.items.contains(where: { $0.id == id }) { return .queued }
                if let change, let next = await switched(started.snapshot.mode, by: change) { await started.conversation.setMode(next) }
                guard !Task.isCancelled, !closed else { return .refused("No answer in time.") }
                // Compose, where the person sees home, is pressed as they would.
                if !started.sent, let compose = homeInSight?.voiceTouchCompose() { await VoiceTouch.play(compose) }
                guard !Task.isCancelled, !closed else { return .refused("No answer in time.") }
                guard await started.conversation.send(id: id, text: text) else { return .refused("It couldn't be kept on this phone.") }
                started.sent = true
                return .queued
            }
            // New work on screen: its own screen sends, and its first message makes it.
            guard let draft = draftChat(agentId) else { return .refused("That new work was closed before anything was sent.") }
            if draft.callSnapshot.items.contains(where: { $0.id == id }) { return .queued }
            if let change, let next = await switched(draft.callMode, by: change) { await draft.pickFromCall(next) }
            guard !Task.isCancelled, !closed else { return .refused("No answer in time.") }
            return await draft.sendFromCall(id: id, text: text) ? .queued : .refused("It couldn't be kept on this phone.")
        }
        return await borrowing(agentId) { chat in
            // Read as the call's context read it: a send never judges a page not there yet.
            guard await Self.loaded(chat) else { return .refused("That conversation is still loading; try again in a moment.") }
            let snapshot = chat.snapshot
            // Under an ID it already has, it went the first time.
            if snapshot.items.contains(where: { $0.id == id }) { return .queued }
            // Checked again here, where the send happens: a question that came
            // while the call's context read the conversation still stops it.
            let now = CallTargetState.from(snapshot, target: target)
            guard now.writable else { return .refused("That conversation can't take a message now.") }
            guard !now.needsInput else { return .refused("It's waiting for the person in the app; answer there first.") }
            // Past the tool's deadline, or the call over: it doesn't go.
            guard !Task.isCancelled, !closed else { return .refused("No answer in time.") }
            // As the composer's pickers would have switched it: its screen, if
            // it shows, says so at once.
            if let change, let next = await switched(snapshot.mode, by: change) {
                if let shown = shell?.stack.compactMap({ $0 as? ChatViewController }).last(where: { $0.shownAgentId == agentId }) {
                    await shown.pickFromCall(next)
                } else {
                    await chat.conversation.setMode(next)
                }
            }
            // Refused only when this phone can't keep it: the call's targets are made tasks, never new ones.
            if await chat.conversation.send(id: id, text: text) {
                Analytics.shared.voiceSent(to: agentId, in: session.snapshot)
                return .queued
            }
            return .refused("It couldn't be kept on this phone.")
        }
    }

    /// `mode` (else what new work starts on) as `change` makes it; nil
    /// when the computer's models aren't known.
    private func switched(_ mode: AgentWire.Mode?, by change: CallModeChange) async -> AgentWire.Mode? {
        guard let catalog = await catalog(), let current = mode ?? session.newWorkMode else { return nil }
        return change.applied(to: current, catalog: catalog)
    }

    /// `named` with the names known now, for an update that can't wait:
    /// the ones it lacks are asked for, for the next.
    private func namedNow(_ state: CallTargetState) -> CallTargetState {
        let me = session.home.userId
        if !state.authors.subtracting(names.keys).subtracting(asked).filter({ $0 != me }).isEmpty {
            Task { _ = await self.named(state) }
        }
        return state.named(names, me: me)
    }

    /// The conversations held for the call.
    var following: [String] { Array(held.keys) }

    func follow(_ agentId: String, _ following: Bool) async {
        if following {
            guard !closed, held[agentId] == nil, let target = target(agentId) else { return }
            let hold = session.warm.hold(agentId)
            held[agentId] = hold
            session.warm.watch(hold.chat, token: hold.token) { [weak self] snapshot in
                // Gone from the sidebar: nothing about it goes, under its old name or any.
                guard snapshot.loaded, let self, let now = self.target(agentId) else { return }
                self.onChange?(self.namedNow(.from(snapshot, target: now)))
            }
            // What it says now is the call's first sight of it: what was there already.
            if hold.chat.snapshot.loaded { onChange?(namedNow(.from(hold.chat.snapshot, target: target))) }
        } else if let hold = held.removeValue(forKey: agentId) {
            session.warm.release(hold.chat, token: hold.token, opened: false)
        }
    }

    /// The directory as the rows change, home's and the spaces sidebar's:
    /// on every change, a status too, for the call's context to tell what
    /// matters.
    func watchDirectory(_ changed: @escaping ([CallTarget]) -> Void) -> Watch {
        let home = session.watchHome { [weak self] _ in
            guard let self, !self.closed else { return }
            changed(self.rows)
        }
        let spaces = session.watch { [weak self] _ in
            guard let self, !self.closed else { return }
            changed(self.rows)
        }
        return Watch { home.invalidate(); spaces.invalidate() }
    }
}
#endif
