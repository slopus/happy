#if canImport(UIKit)
import HappyAnalytics
import HappyCore
import UIKit

/// A call's tools and context over one agent connection: its sidebar for
/// the directory, its kept conversations (`WarmChats`) for what they say,
/// and the conversation's own send, which the composer uses too but which
/// here leaves the composer's draft and attachments alone. New work is
/// compose's own screen (`NewWork`), and the model and effort the
/// composer's pickers' (`ModelCatalog.select`, `Conversation.setMode`).
@MainActor
final class SessionCallTargets: CallTargets {
    private let session: Session
    private weak var shell: ShellViewController?
    /// Conversations the call follows, held so they stay read.
    private var held: [String: (chat: WarmChats.Chat, token: UUID)] = [:]
    /// New work's screens the call has seen, until their first message makes them.
    private var drafts: [String: Weak] = [:]
    private struct Weak { weak var chat: ChatViewController? }
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
            guard let draft = draftChat(agentId), let choice = draft.unmadeChoice else { return nil }
            var state = CallTargetState.from(draft.callSnapshot, target: Self.target(agentId, choice))
            // Empty until its first message: nothing to read, and it takes one.
            state.writable = draft.callSnapshot.error == nil
            return await withModels(state, mode: draft.callMode)
        }
        let read: (CallTargetState, AgentWire.Mode?)? = await borrowing(agentId) { chat in
            // One bounded read: about three seconds for its first page, less
            // if the tool's time runs out first.
            for _ in 0..<60 where !chat.snapshot.loaded && !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
            }
            guard chat.snapshot.loaded else { return nil }
            return (.from(chat.snapshot, target: target), chat.snapshot.mode)
        }
        guard let read else { return nil }
        return await withModels(read.0, mode: read.1)
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
        guard target(agentId) == nil, let chat = draftChat(agentId), let choice = chat.unmadeChoice else { return nil }
        return Self.target(agentId, choice)
    }

    /// The app's kept chat for `agentId` while `use` runs: the call's own
    /// hold when it follows the conversation, else a hold of its own, let
    /// go of after, whatever else held it meanwhile. The chat is the one its
    /// screen shows, so what a send does shows there.
    private func borrowing<T>(_ agentId: String, _ use: @MainActor (WarmChats.Chat) async -> T) async -> T {
        if let hold = held[agentId] { return await use(hold.chat) }
        let hold = session.warm.hold(agentId)
        let result = await use(hold.chat)
        session.warm.release(hold.chat, token: hold.token, opened: false)
        return result
    }

    func focused() async -> String? { focusedNow }

    var focusedNow: String? {
        (shell?.topViewController as? ChatViewController)?.shownAgentId
    }

    func open(_ agentId: String) async -> Bool {
        guard !closed, let shell, let row = allRows.first(where: { $0.agentId == agentId && CallTarget.from($0) != nil }) else { return false }
        if focusedNow == agentId { return true }
        // Past the tool's deadline: nothing moves on screen.
        guard !Task.isCancelled else { return false }
        let chat = ChatViewController(session: session, agentId: agentId, title: row.label, spaceId: row.spaceId, intro: nil)
        await place(chat, in: shell)
        #if DEBUG
        print("[call] stack \(shell.stack.map { ($0 as? ChatViewController)?.shownAgentId ?? String(describing: type(of: $0)) })")
        #endif
        return true
    }

    /// Compose's new work, chosen as the call asks, on screen as `open`
    /// puts a conversation there. The same unsent work compose would open
    /// (`Store.newTask`): already in front, it only takes the choice.
    func newWork(_ kind: CallTarget.Kind, name: String) async -> CallTarget? {
        guard !closed, let shell else { return nil }
        let task = await session.store.newTask()
        guard !closed, !Task.isCancelled else { return nil }
        let choice = NewTask.Choice(kind: kind == .bot ? .bot : .task, name: name)
        if let shown = shell.topViewController as? ChatViewController, shown.shownAgentId == task.agentId, shown.unmadeChoice != nil {
            shown.choose(newWork: choice)
            drafts[task.agentId] = Weak(chat: shown)
            return Self.target(task.agentId, choice)
        }
        task.choice = choice
        let chat = NewWork.chat(session, task: task)
        // The person is talking, not typing: no keyboard.
        chat.focusesOnOpen = false
        drafts[task.agentId] = Weak(chat: chat)
        await place(chat, in: shell)
        return Self.target(task.agentId, choice)
    }

    /// Where `open` and `newWork` put a screen: the main panel's root beside
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
        shell.setStack(Array(stack.dropLast()), animated: true)
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
            await withCheckedContinuation { done in shell.dismiss(animated: true) { done.resume() } }
        }
        let stack = shell.stack
        if stack.count > 1, let root = stack.first {
            shell.setStack([root], animated: true)
            await Self.settle(shell.stackTransition)
        }
        return .moved(atHome: true)
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
            // New work: its own screen sends, and its first message makes it.
            guard let draft = draftChat(agentId) else { return .refused("That new work was closed before anything was sent.") }
            if draft.callSnapshot.items.contains(where: { $0.id == id }) { return .queued }
            if let change, let next = await switched(draft.callMode, by: change) { await draft.pickFromCall(next) }
            guard !Task.isCancelled, !closed else { return .refused("No answer in time.") }
            return await draft.sendFromCall(id: id, text: text) ? .queued : .refused("It couldn't be kept on this phone.")
        }
        return await borrowing(agentId) { chat in
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
                self.onChange?(.from(snapshot, target: now))
            }
            // What it says now is the call's first sight of it: what was there already.
            if hold.chat.snapshot.loaded { onChange?(.from(hold.chat.snapshot, target: target)) }
        } else if let hold = held.removeValue(forKey: agentId) {
            session.warm.release(hold.chat, token: hold.token, opened: false)
        }
    }

    func watchDirectory(_ changed: @escaping ([CallTarget]) -> Void) -> Watch {
        let home = session.watchHome { [weak self] _ in
            guard let self else { return }
            changed(self.rows)
        }
        let spaces = session.watch { [weak self] _ in
            guard let self else { return }
            changed(self.rows)
        }
        return Watch { home.invalidate(); spaces.invalidate() }
    }
}
#endif
