#if DEBUG && canImport(UIKit)
import Combine
import ElevenLabs
import HappyCore

/// Debug builds only: what a live call heard, said and ran, for the
/// harness's live check (`-callLive`). It keeps words and tool calls,
/// never the agent's ID or a token.
@MainActor
enum CallProbe {
    struct Line: Equatable {
        var id: String
        var role: String
        var text: String
    }

    struct ToolRun {
        var name: String
        var parameters: String
        var result: String
        var isError: Bool
    }

    /// The conversation's messages in order, each as it last read.
    private(set) static var transcript: [Line] = []
    private(set) static var tools: [ToolRun] = []
    private(set) static var agentSpeaking = false
    /// What the call started with: its one variable, and the provider's ID for the conversation.
    private(set) static var context = ""
    private(set) static var conversationId: String?
    static var onChange: (() -> Void)?
    /// Every contextual update and prompt sent, by UTF-8 size.
    private(set) static var sent: [(kind: String, bytes: Int)] = []

    static func watch(_ conversation: ElevenLabsConversation, context: String, store: inout Set<AnyCancellable>) {
        transcript = []
        tools = []
        sent = []
        self.context = context
        conversationId = nil
        conversation.$conversationMetadata.compactMap { $0?.conversationId }.sink { id in
            MainActor.assumeIsolated { conversationId = id }
        }.store(in: &store)
        conversation.$messages.sink { messages in
            MainActor.assumeIsolated {
                transcript = messages.map { Line(id: $0.id, role: $0.role == .user ? "user" : "agent", text: $0.content) }
                onChange?()
            }
        }.store(in: &store)
        conversation.$agentState.removeDuplicates().sink { state in
            MainActor.assumeIsolated {
                agentSpeaking = state == .speaking
                onChange?()
            }
        }.store(in: &store)
    }

    static func sent(_ kind: String, _ text: String) {
        sent.append((kind, text.utf8.count))
    }

    static func tool(_ call: CallToolCall, _ result: CallToolResult) {
        let run = ToolRun(name: call.name, parameters: String(decoding: call.parameters, as: UTF8.self), result: result.text, isError: result.isError)
        tools.append(run)
        print("[call] tool \(run.name) \(run.parameters) -> \(run.isError ? "error " : "")\(run.result.prefix(300))")
        onChange?()
    }
}
#endif
