import Foundation

/// Accepted locally before any POST. Every retry, including after a lost
/// acknowledgement or process death, uses this exact message ID and payload.
public struct QueuedMessage: Codable, Equatable, Sendable {
    public struct Picture: Codable, Equatable, Sendable {
        public var mimeType: String
        public var data: Data
        public init(mimeType: String, data: Data) { self.mimeType = mimeType; self.data = data }
    }
    public var id: String
    public var agentID: String
    public var text: String
    public var pictures: [Picture]
    /// Absent in outbox records written before direct file uploads.
    public var files: [QueuedFile]?
    /// Captured before the first upload; retries keep the same execution folder.
    public var workspaceID: String?
    public var mode: AgentWire.Mode?
    public var failure: String?
    /// A skill command's `read_skill` request; absent from every other send.
    public var toolRequest: AgentWire.ToolCallRequest?
    /// The suggested reply it is; absent from every other send.
    public var quickReply: QuickReply?
    public init(id: String, agentID: String, text: String, pictures: [Picture], mode: AgentWire.Mode?, files: [QueuedFile]? = nil, workspaceID: String? = nil,
                toolRequest: AgentWire.ToolCallRequest? = nil, quickReply: QuickReply? = nil) {
        self.id = id; self.agentID = agentID; self.text = text; self.pictures = pictures; self.mode = mode
        self.files = files; self.workspaceID = workspaceID; self.toolRequest = toolRequest; self.quickReply = quickReply
    }
}

public enum DeliveryEvent: Sendable {
    case accepted(String)
    case failed(String, String)
}