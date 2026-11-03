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

    var rows: [CallTarget] {
        var seen = Set<String>()
        return allRows.compactMap(CallTarget.from).filter { seen.insert($0.agentId).inserted }
    }

    private func target(_ agentId: String) -> CallTarget? {
        rows.first { $0.agentId == agentId }
    }

    func directory() async -> [CallTarget] { rows }

    func state(of agentId: String) async -> CallTargetState? {
        guard let target = target(agentId) else { return nil }
        if let hold = held[agentId], hold.chat.snapshot.loaded {
            return .from(hold.chat.snapshot, target: target)
        }
        let hold = session.warm.hold(agentId)
        defer { if held[agentId] == nil { session.warm.release(hold.chat, token: hold.token, opened: false) } }
        // One bounded read: about three seconds for its first page.
        for _ in 0..<60 where !hold.chat.snapshot.loaded {
            try? await Task.sleep(for: .milliseconds(50))
        }
        guard hold.chat.snapshot.loaded else { return nil }
        return .from(hold.chat.snapshot, target: target)
    }

    func focused() async -> String? { focusedNow }

    var focusedNow: String? {
        (shell?.topViewController as? ChatViewController)?.shownAgentId
    }

    func open(_ agentId: String) async -> Bool {
        guard !closed, let shell, let row = allRows.first(where: { $0.agentId == agentId && CallTarget.from($0) != nil }) else { return false }
        if focusedNow == agentId { return true }
        let chat = ChatViewController(session: session, agentId: agentId, title: row.label, spaceId: row.spaceId, intro: nil)
        if shell.isExpanded { shell.showInMain(chat, animated: true) }
        else { shell.phone.pushViewController(chat, animated: true) }
        return true
    }

    func send(_ agentId: String, text: String, id: String) async -> CallSendOutcome {
        guard !closed, let target = target(agentId) else { return .refused("The call has ended.") }
        let hold = held[agentId] ?? session.warm.hold(agentId)
        defer { if held[agentId] == nil { session.warm.release(hold.chat, token: hold.token, opened: false) } }
        let snapshot = hold.chat.snapshot
        // Under an ID it already has, it went the first time.
        if snapshot.items.contains(where: { $0.id == id }) { return .queued }
        // Checked again here, where the send happens: a question that came
        // while the call's context read the conversation still stops it.
        let now = CallTargetState.from(snapshot, target: target)
        guard now.writable else { return .refused("That conversation can't take a message now.") }
        guard !now.needsInput else { return .refused("It's waiting for the person in the app; answer there first.") }
        if await hold.chat.conversation.send(id: id, text: text) { return .queued }
        return .refused(await hold.chat.conversation.sendRefusal ?? "It couldn't be kept on this phone.")
    }

    /// The conversations held for the call.
    var following: [String] { Array(held.keys) }

    func follow(_ agentId: String, _ following: Bool) async {
        if following {
            guard !closed, held[agentId] == nil, let target = target(agentId) else { return }
            let hold = session.warm.hold(agentId)
            held[agentId] = hold
            session.warm.watch(hold.chat, token: hold.token) { [weak self] snapshot in
                guard snapshot.loaded else { return }
                self?.onChange?(.from(snapshot, target: self?.target(agentId) ?? target))
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
