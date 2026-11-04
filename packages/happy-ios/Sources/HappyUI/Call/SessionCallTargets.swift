#if canImport(UIKit)
import HappyCore
import UIKit

/// A call's tools and context over one agent connection: its sidebar for
/// the directory, its kept conversations (`WarmChats`) for what they say,
/// and the conversation's own send, which the composer uses too but which
/// here leaves the composer's draft and attachments alone.
@MainActor
final class SessionCallTargets: CallTargets {
    private let session: Session
    private weak var shell: ShellViewController?
    /// Conversations the call follows, held so they stay read.
    private var held: [String: (chat: WarmChats.Chat, token: UUID)] = [:]
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
        guard let target = target(agentId) else { return nil }
        return await borrowing(agentId) { chat in
            // One bounded read: about three seconds for its first page, less
            // if the tool's time runs out first.
            for _ in 0..<60 where !chat.snapshot.loaded && !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
            }
            guard chat.snapshot.loaded else { return nil }
            return .from(chat.snapshot, target: target)
        }
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
        let navigation: UINavigationController = shell.isExpanded ? shell.main : shell.phone
        if shell.isExpanded, navigation.viewControllers.allSatisfy({ $0 === shell.placeholder }) {
            shell.showInMain(chat, animated: true)
        } else {
            // In place of a conversation on top; over anything else, which stays.
            let stack = CallNavigation.opening(chat, over: navigation.viewControllers) { $0 is ChatViewController }
            navigation.setViewControllers(stack, animated: true)
        }
        // In front once it has slid in, so the screen saying so comes
        // before the next open does, never after it.
        if let coordinator = chat.navigationController?.transitionCoordinator {
            await withCheckedContinuation { done in coordinator.animate(alongsideTransition: nil) { _ in done.resume() } }
        }
        #if DEBUG
        print("[call] stack \(navigation.viewControllers.map { ($0 as? ChatViewController)?.shownAgentId ?? String(describing: type(of: $0)) })")
        #endif
        return true
    }

    func send(_ agentId: String, text: String, id: String) async -> CallSendOutcome {
        guard !closed, let target = target(agentId) else { return .refused("The call has ended.") }
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
            // Refused only when this phone can't keep it: the call's targets are made tasks, never new ones.
            if await chat.conversation.send(id: id, text: text) { return .queued }
            return .refused("It couldn't be kept on this phone.")
        }
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
