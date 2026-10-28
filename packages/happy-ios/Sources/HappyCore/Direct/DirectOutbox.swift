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
    public var mode: AgentWire.Mode?
    public var failure: String?
    public init(id: String, agentID: String, text: String, pictures: [Picture], mode: AgentWire.Mode?) {
        self.id = id; self.agentID = agentID; self.text = text; self.pictures = pictures; self.mode = mode
    }
}

public enum DirectDeliveryEvent: Sendable {
    case accepted(String)
    case failed(String, String)
}