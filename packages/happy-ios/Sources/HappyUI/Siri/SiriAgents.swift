#if canImport(UIKit)
import HappyCore
import UIKit

/// What Siri's intents do (`HappyApp/AgentIntents.swift`), in the app's
/// own process over the open agent connection: home's rows as this phone
/// keeps them (offline first), and the conversation's own send, the one
/// the composer and the call's `message` use. While an intent answers,
/// the connection runs as in the foreground (`AppContext.holdConnection`),
/// window or not, phone locked or not, so a send reaches the computer
/// before the app is suspended again.
@MainActor
public enum SiriAgents {
    /// One of home's conversations, as Siri lists and names it.
    public struct Agent: Equatable, Sendable {
        public let id: String
        /// As it is said (`AgentsSummary.name`).
        public let name: String
        /// What it sits under, said, for telling two of a name apart.
        public let under: String?
    }

    /// How long an intent waits for the computer before it answers from
    /// what the phone kept.
    static let liveWait: Duration = .seconds(4)
    /// How long a send waits for the computer to take it.
    static let deliveryWait: Duration = .seconds(8)

    /// "What are my agents doing?"
    public static func summary(_ context: AppContext) async -> String {
        await withSession(context) { session, live in
            AgentsSummary.text(rows: rows(session), now: Date().timeIntervalSince1970 * 1000, live: live)
        } ?? Strings.Siri.noConnection
    }

    /// Home's conversations, in the sidebar's order, for Siri to suggest
    /// and resolve a name against; none without a connection.
    public static func agents(_ context: AppContext) async -> [Agent] {
        await withSession(context, wait: .zero) { session, _ in
            CallTarget.list(rows(session)).map(agent)
        } ?? []
    }

    /// The conversations a name Siri heard means, best first (`AgentNameMatch`).
    public static func agents(matching said: String, _ context: AppContext) async -> [Agent] {
        await withSession(context, wait: .zero) { session, _ in
            AgentNameMatch.matches(said, in: CallTarget.list(rows(session))).map(agent)
        } ?? []
    }

    /// "Tell ‹agent› to …": the person's words, verbatim, through the
    /// conversation's own send, then a wait for the computer to take them.
    /// Returns what Siri says.
    public static func send(_ text: String, to agentId: String, _ context: AppContext) async -> String {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return Strings.Siri.nothingToSend }
        return await withSession(context) { session, _ in
            let targets = SessionCallTargets(session: session, shell: nil)
            targets.countsVoiceSends = false
            defer { targets.close() }
            guard let target = targets.rows.first(where: { $0.agentId == agentId }) else { return Strings.Siri.gone }
            let name = AgentsSummary.name(target)
            let id = ClientID.make()
            if target.status == .needsInput { return Strings.Siri.waiting(name) }
            guard await targets.send(agentId, text: words, id: id, change: nil) == .queued else { return Strings.Siri.refused(name) }
            // Held until the computer has it, or the wait runs out: then it
            // waits in the outbox for the next time Happy reaches it.
            let deadline = ContinuousClock.now + deliveryWait
            while ContinuousClock.now < deadline {
                let delivery = await targets.state(of: agentId)?.messages.first { $0.id == id }?.delivery
                if delivery == .accepted { return Strings.Siri.sent(name) }
                if delivery == .failed { return Strings.Siri.failed(name) }
                try? await Task.sleep(for: .milliseconds(300))
            }
            return Strings.Siri.queued(name)
        } ?? Strings.Siri.noConnection
    }

    /// "Read me ‹agent›'s last reply": read current first, as a call's
    /// read is (`SessionCallTargets.refreshed`), then said (`SpokenReply`).
    public static func lastReply(of agentId: String, _ context: AppContext) async -> String {
        await withSession(context) { session, _ in
            let targets = SessionCallTargets(session: session, shell: nil)
            defer { targets.close() }
            guard let target = targets.rows.first(where: { $0.agentId == agentId }) else { return Strings.Siri.gone }
            let name = AgentsSummary.name(target)
            guard let state = await targets.refreshed(agentId, within: liveWait) else { return Strings.Siri.unreadable(name) }
            guard let reply = SpokenReply.last(in: state) else { return Strings.Siri.noReply(name) }
            return Strings.Siri.reply(name, reply, working: state.working)
        } ?? Strings.Siri.noConnection
    }

    // MARK: The connection

    /// `work` over the open agent connection's session, held running for
    /// it: the stored accounts read first if nothing has read them (a
    /// launch with no window), and up to `wait` for the computer to answer.
    /// Nil when there is no agent connection open.
    private static func withSession<T>(_ context: AppContext, wait: Duration = liveWait,
                                       _ work: (Session, _ live: Bool) async -> T) async -> T? {
        let release = await context.holdConnection()
        defer { release() }
        await context.restoreAccounts()
        let connections = context.account.agentConnections
        guard let active = connections.active, !active.revoked,
              let session = Session.session(for: active.id, context: context) else { return nil }
        let deadline = ContinuousClock.now + wait
        while !session.snapshot.live, ContinuousClock.now < deadline, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(100))
        }
        return await work(session, session.snapshot.live)
    }

    /// Home's rows, then the spaces sidebar's, as a call's directory reads them.
    private static func rows(_ session: Session) -> [Row] {
        session.home.allRows + session.snapshot.allRows
    }

    private static func agent(_ target: CallTarget) -> Agent {
        let under = target.parents.last.map { AgentsSummary.spoken($0.title) }
        return Agent(id: target.agentId, name: AgentsSummary.name(target), under: under?.isEmpty == true ? nil : under)
    }
}
#endif
