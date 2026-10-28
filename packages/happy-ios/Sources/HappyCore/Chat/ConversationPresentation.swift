import Foundation

/// UI-framework-neutral text and actions for a conversation row. A platform
/// view chooses typography and controls; it never decodes protocol records.
public struct ConversationRow: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable { case user, agent, thinking, tool, event, unsupported }
    public var id: String
    public var kind: Kind
    public var heading: String
    public var text: String
    public var detail: String?
    public var permissionID: String?
    public var localID: String?
    public var delivery: OutboxDelivery?

    public static func make(_ snapshot: ChatSnapshot) -> [ConversationRow] {
        snapshot.messages.map { message in
            var row = ConversationRow(id: message.id, kind: .event, heading: "", text: "")
            switch message {
            case .userText(let value):
                row.kind = .user; row.heading = value.author?.name ?? "You"
                row.text = value.displayText ?? value.text
                row.localID = value.localId
                row.delivery = value.localId.flatMap { snapshot.delivery[$0] }
            case .agentText(let value):
                row.kind = value.isThinking ? .thinking : .agent
                row.heading = value.isThinking ? "Thinking" : "Agent"
                row.text = value.text
            case .toolCall(let value):
                row.kind = .tool
                row.heading = value.tool.title ?? value.tool.name
                row.text = value.tool.description ?? value.tool.state.rawValue.capitalized
                row.detail = value.tool.result.flatMap { try? $0.encodedString() }
                if value.tool.permission?.status == .pending { row.permissionID = value.tool.permission?.id }
            case .agentEvent(let value):
                switch value.event {
                case .message(let text): row.text = text
                case .modeSwitch(let mode): row.text = "Mode: \(mode)"
                case .limitReached: row.text = "Usage limit reached"
                default: break
                }
            case .unsupported:
                row.kind = .unsupported; row.text = "Unsupported message"
            }
            return row
        }.filter { !$0.text.isEmpty || !$0.heading.isEmpty }
    }
}

/// Stable identities let either platform update only the rows that changed.
public struct ConversationChanges: Equatable, Sendable {
    public var membershipChanged: Bool
    public var changed: IndexSet

    public init(previous: [ConversationRow], next: [ConversationRow]) {
        membershipChanged = previous.map(\.id) != next.map(\.id)
        changed = IndexSet(next.indices.filter { $0 >= previous.count || previous[$0] != next[$0] })
    }
}