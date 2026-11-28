#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A tool result measured with the same native planner as artifact Gen UI,
/// but without an artifact card, file loader or privileged action host.
struct GenUIMessageEmbed: Equatable, Sendable {
    var agentId: String?
    var toolCallId: String
    var document: GenUIRenderDocument
    var width: CGFloat
    var planner: GenUIPlanner
    /// The server's `capabilities.plugins`: a `plugin` element opens its page.
    var plugins: Bool

    init(agentId: String?, toolCallId: String, document: GenUIRenderDocument, width: CGFloat, environment: TextEnvironment?, plugins: Bool = false) {
        self.agentId = agentId
        self.toolCallId = toolCallId
        self.document = document
        self.width = width
        self.plugins = plugins
        planner = GenUIMessagePlanners.planner(agentId: agentId, toolCallId: toolCallId, document: document, traits: GenUITraits(text: environment, displayScale: environment?.displayScale ?? 2))
    }

    var height: CGFloat { planner.height(width: width) }
    var identity: String { "message/\(agentId ?? "")/\(toolCallId)" }

    static func == (a: Self, b: Self) -> Bool {
        a.agentId == b.agentId && a.toolCallId == b.toolCallId && a.document == b.document && a.width == b.width && a.plugins == b.plugins && a.planner === b.planner
    }
}

/// Streaming text elsewhere in the chat must not remeasure an unchanged block.
private enum GenUIMessagePlanners {
    private struct Key: Hashable { var agentId: String?; var toolCallId: String; var traits: GenUITraits }
    private static let lock = NSLock()
    nonisolated(unsafe) private static var cached: [Key: (GenUIRenderDocument, GenUIPlanner)] = [:]

    static func planner(agentId: String?, toolCallId: String, document: GenUIRenderDocument, traits: GenUITraits) -> GenUIPlanner {
        let key = Key(agentId: agentId, toolCallId: toolCallId, traits: traits)
        return lock.withLock {
            if let held = cached[key], held.0 == document { return held.1 }
            if cached.count >= 64 { cached.removeAll() }
            let planner = GenUIPlanner(document: document, traits: traits)
            cached[key] = (document, planner)
            return planner
        }
    }
}

@MainActor
protocol GenUIMessageActing: AnyObject {
    func genUIMessage(run action: GenUIAction, agentId: String)
}

extension GenUIBlockView {
    func apply(_ embed: GenUIMessageEmbed) {
        accessibilityIdentifier = "chat-gen-ui-message"
        conversationVersion = nil
        conversationMessage = embed.identity
        interaction.onViewer = nil
        // No artifact authority: no secret forms, and a plugin's page reports no setup.
        let host = GenUIHost(server: .happyAgent, origin: embed.agentId != nil, secretActions: false, plugins: embed.plugins)
        var runs = GenUIRuns(host: host, sends: embed.agentId != nil, forms: false)
        runs.messageOnly = true
        interaction.onAction = { [weak self] _, action in
            guard let self, let agentId = embed.agentId, runs(action),
                  let host = GenUIChatFiles.host(self) as? GenUIMessageActing else { return }
            host.genUIMessage(run: action, agentId: agentId)
        }
        show(embed.planner, width: embed.width, identity: embed.identity, files: nil, runs: runs)
        sharesAnswers()
    }
}
#endif