#if canImport(UIKit)
import Combine
import ElevenLabs
import HappyCore
import UIKit

/// The hosted call agent over the official SDK. Apart from the relay's
/// `ElevenLabsVoiceConnection` on purpose: no prompt, greeting or relay
/// tools are sent; the hosted agent has its own, and its one variable is
/// `initialConversationContext`. Tool calls are answered one at a time, by
/// their provider ID, and an ID seen before is never run again.
@MainActor
final class ElevenLabsCallConnection: CallConnection {
    private let conversation: ElevenLabsConversation
    private var observations = Set<AnyCancellable>()
    private var handled = Set<String>()
    private var tools: [String: Task<Void, Never>] = [:]
    private let teardown: Teardown

    private init(_ conversation: ElevenLabsConversation, teardown: Teardown) {
        self.conversation = conversation
        self.teardown = teardown
    }

    static func connect(grant: CallGrant, request: CallStart, events: CallEvents) async throws -> ElevenLabsCallConnection {
        let tracker = Tracker(events.activity)
        let config = ConversationConfig(
            agentOverrides: request.language.flatMap(Language.init(rawValue:)).map { AgentOverrides(language: $0) },
            dynamicVariables: ["initialConversationContext": request.context],
            userId: grant.userId,
            // Foreground only: recording is let go when the call ends.
            audioConfiguration: AudioPipelineConfiguration(recordingAlwaysPrepared: false),
            onVadScore: { score in Task { @MainActor in tracker.vad(score) } }
        )
        let teardown = Teardown()
        let disconnected: @Sendable (DisconnectionReason) -> Void = { _ in
            Task { @MainActor in
                teardown.finish()
                events.disconnected()
            }
        }
        // A minted token when a Happy service grants one; a public agent by its ID otherwise.
        let conversation = if let token = grant.conversationToken {
            try await ElevenLabs.startConversation(conversationToken: token, config: config, onDisconnect: disconnected)
        } else {
            try await ElevenLabs.startConversation(agentId: grant.agentId, config: config, onDisconnect: disconnected)
        }
        let connection = ElevenLabsCallConnection(conversation, teardown: teardown)
        #if DEBUG
        CallProbe.watch(conversation, context: request.context, store: &connection.observations)
        #endif
        conversation.$agentState.removeDuplicates().sink { state in
            tracker.agentSpeaking(state == .speaking)
        }.store(in: &connection.observations)
        conversation.$pendingToolCalls.sink { [weak connection] calls in
            guard let connection else { return }
            for call in calls where connection.handled.insert(call.toolCallId).inserted {
                let request = CallToolCall(id: call.toolCallId, name: call.toolName, parameters: call.parametersData, expectsResponse: call.expectsResponse)
                connection.tools[call.toolCallId] = Task { [weak connection] in
                    let result = await events.tool(request)
                    #if DEBUG
                    CallProbe.tool(request, result)
                    #endif
                    guard !Task.isCancelled, let connection else { return }
                    if request.expectsResponse {
                        try? await connection.conversation.sendToolResult(for: request.id, result: result.text, isError: result.isError)
                    } else {
                        connection.conversation.markToolCallCompleted(request.id)
                    }
                    connection.tools[request.id] = nil
                }
            }
        }.store(in: &connection.observations)
        return connection
    }

    func end() async {
        observations.removeAll()
        for task in tools.values { task.cancel() }
        tools.removeAll()
        await conversation.endConversation()
        // A provider disconnect may already be tearing down; wait for it.
        await teardown.wait()
    }

    func setMuted(_ muted: Bool) async throws { try await conversation.setMuted(muted) }
    func update(_ context: String) async throws {
        #if DEBUG
        CallProbe.sent("update", context)
        #endif
        try await conversation.updateContext(context)
    }

    func say(_ prompt: String) async throws {
        #if DEBUG
        CallProbe.sent("prompt", prompt)
        #endif
        try await conversation.sendMessage(prompt)
    }

    @MainActor
    private final class Teardown {
        private var finished = false
        private var waiters: [CheckedContinuation<Void, Never>] = []
        func finish() {
            finished = true
            let pending = waiters
            waiters.removeAll()
            for waiter in pending { waiter.resume() }
        }
        func wait() async {
            guard !finished else { return }
            await withCheckedContinuation { waiters.append($0) }
        }
    }

    /// Who is speaking, from the agent's state and the person's voice
    /// activity, held 300 ms past the end of the person's speech.
    @MainActor
    private final class Tracker {
        private let changed: @MainActor @Sendable (CallActivity, Double) -> Void
        private var speaking = false
        private var silence: Task<Void, Never>?
        init(_ changed: @escaping @MainActor @Sendable (CallActivity, Double) -> Void) { self.changed = changed }
        func agentSpeaking(_ value: Bool) {
            speaking = value
            silence?.cancel(); silence = nil
            changed(value ? .agentSpeaking : .listening, 0)
        }
        func vad(_ score: Double) {
            guard !speaking else { return }
            if score > 0.5 {
                silence?.cancel(); silence = nil
                changed(.userSpeaking, score)
            } else if silence == nil {
                silence = Task { [weak self] in
                    try? await Task.sleep(for: .milliseconds(300))
                    guard !Task.isCancelled, let self, !self.speaking else { return }
                    self.changed(.listening, 0)
                    self.silence = nil
                }
            }
        }
    }
}
#endif
