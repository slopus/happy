import Foundation
import HappyWire

/// Whether the agent a tapped push names is on the server its connection
/// is to. A push is taken from whoever holds the relay token, and one
/// shown a while ago may name an agent since gone: home not listing it
/// says little (a new agent, a home read long ago, a task not joined), so
/// its server is asked (`GET /v0/agents/:id`).
public enum PushedAgent {
    public enum Answer: Equatable, Sendable {
        /// The server has it; `title` is its name there.
        case there(title: String?)
        /// The server said it has no such agent (404): nothing opens.
        case gone
        /// No answer in time, a server out of reach, or an answer that
        /// says neither: its chat opens as it did unasked.
        case unknown
    }

    /// How long a tap waits for the answer before the chat opens anyway.
    public static let limit: Duration = .seconds(4)

    public static func ask(_ agentId: String, client: AgentClient, limit: Duration = limit) async -> Answer {
        .unknown
    }
}
