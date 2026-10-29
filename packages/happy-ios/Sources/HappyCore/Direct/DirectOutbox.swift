import Foundation

/// Accepted locally before any POST. Every retry, including after a lost
/// acknowledgement or process death, uses this exact message ID and payload.
public struct DirectQueuedMessage: Codable, Equatable, Sendable {
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
    public var files: [DirectQueuedFile]?
    /// Captured before the first upload; retries keep the same execution folder.
    public var workspaceID: String?
    public var mode: AgentWire.Mode?
    public var failure: String?
    public init(id: String, agentID: String, text: String, pictures: [Picture], mode: AgentWire.Mode?, files: [DirectQueuedFile]? = nil, workspaceID: String? = nil) {
        self.id = id; self.agentID = agentID; self.text = text; self.pictures = pictures; self.mode = mode
        self.files = files; self.workspaceID = workspaceID
    }
}

public enum DirectDeliveryEvent: Sendable {
    case accepted(String)
    case failed(String, String)
}