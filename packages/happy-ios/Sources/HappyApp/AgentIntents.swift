#if canImport(UIKit) && canImport(AppIntents)
import AppIntents
import HappyUI

// Siri and Shortcuts over the open agent connection, in the app's own
// process (`SiriAgents`). Every intent runs with the phone locked: the
// connection's credentials are readable after the first unlock
// (`KeychainAgentConnectionCredentialStore`), and nothing here asks to
// unlock. That includes the send: anyone holding the locked phone can tell
// an agent something by voice, as they could hear what it is doing.

/// One of home's conversations, for Siri to resolve a spoken name to.
struct AgentEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Agent"
    static let defaultQuery = AgentQuery()

    let id: String
    let name: String
    let under: String?

    init(_ agent: SiriAgents.Agent) {
        id = agent.id
        name = agent.name
        under = agent.under
    }

    var displayRepresentation: DisplayRepresentation {
        if let under { return DisplayRepresentation(title: "\(name)", subtitle: "\(under)") }
        return DisplayRepresentation(title: "\(name)")
    }
}

/// Home's rows as Siri's choices: suggested in the sidebar's order, and
/// matched by name as `AgentNameMatch` ranks them.
struct AgentQuery: EntityStringQuery {
    @MainActor
    func entities(for identifiers: [String]) async throws -> [AgentEntity] {
        let all = await SiriAgents.agents(CompositionRoot.context)
        return identifiers.compactMap { id in all.first { $0.id == id }.map(AgentEntity.init) }
    }

    @MainActor
    func suggestedEntities() async throws -> [AgentEntity] {
        await SiriAgents.agents(CompositionRoot.context).map(AgentEntity.init)
    }

    @MainActor
    func entities(matching string: String) async throws -> [AgentEntity] {
        await SiriAgents.agents(matching: string, CompositionRoot.context).map(AgentEntity.init)
    }
}

/// "What are my agents doing?"
struct AgentsStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "What Are My Agents Doing"
    static let description = IntentDescription("Hear which of your agents need you, which are working, and which finished recently.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
    static let openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = await SiriAgents.summary(CompositionRoot.context)
        return .result(dialog: "\(text)")
    }
}

/// "Tell ‹agent› to …": the words go verbatim, as the composer sends them.
struct TellAgentIntent: AppIntent {
    static let title: LocalizedStringResource = "Tell an Agent"
    static let description = IntentDescription("Send your words, as you say them, to one of your agents.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
    static let openAppWhenRun = false

    @Parameter(title: "Agent", requestValueDialog: "Which agent?")
    var agent: AgentEntity

    @Parameter(title: "Message", requestValueDialog: "What should I tell it?")
    var message: String

    static var parameterSummary: some ParameterSummary {
        Summary("Tell \(\.$agent) \(\.$message)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = await SiriAgents.send(message, to: agent.id, CompositionRoot.context)
        return .result(dialog: "\(text)")
    }
}

/// "Read me ‹agent›'s last reply."
struct LastReplyIntent: AppIntent {
    static let title: LocalizedStringResource = "Read an Agent's Last Reply"
    static let description = IntentDescription("Hear the last thing one of your agents said, without its code.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
    static let openAppWhenRun = false

    @Parameter(title: "Agent", requestValueDialog: "Which agent?")
    var agent: AgentEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Read \(\.$agent)'s last reply")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = await SiriAgents.lastReply(of: agent.id, CompositionRoot.context)
        return .result(dialog: "\(text)")
    }
}

/// Phrases that work with no setup.
struct HappyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AgentsStatusIntent(), phrases: [
            "What are my agents doing in \(.applicationName)",
            "Ask \(.applicationName) what my agents are doing",
            "What's happening in \(.applicationName)",
        ], shortTitle: "Agents' Status", systemImageName: "person.3")
        AppShortcut(intent: TellAgentIntent(), phrases: [
            "Tell \(\.$agent) in \(.applicationName)",
            "Message \(\.$agent) in \(.applicationName)",
            "Tell an agent in \(.applicationName)",
            "Send a message with \(.applicationName)",
        ], shortTitle: "Tell an Agent", systemImageName: "paperplane")
        AppShortcut(intent: LastReplyIntent(), phrases: [
            "Read me \(\.$agent)'s last reply in \(.applicationName)",
            "What did \(\.$agent) say in \(.applicationName)",
            "Read me an agent's last reply in \(.applicationName)",
        ], shortTitle: "Last Reply", systemImageName: "text.bubble")
    }
}
#endif
