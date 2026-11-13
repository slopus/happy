import Foundation
import HappyWire

/// A Happy Cloud server's two documents every agent follows, kept in its
/// settings (happy-agent API.md, `/v0/config/instructions` and
/// `/v0/config/security`): anyone reads them, only those granted
/// `policy.edit` (owners) change them, and no agent does.
public enum PolicyDocument: String, CaseIterable, Sendable {
    /// AGENTS.md: the server's instructions.
    case instructions
    /// SECURITY.md: its security policy.
    case security

    var path: String { "/v0/config/\(rawValue)" }
    /// The text's key in the request and the answer.
    var key: String { self == .instructions ? "instructions" : "policy" }
    /// The longest the server keeps, in UTF-8 bytes.
    public var limit: Int { self == .instructions ? 256 * 1024 : 32 * 1024 }

    // MARK: Legacy: delete once happy-cluster serves the documents everywhere

    /// Whether a server serves the documents from its settings: one that
    /// still flags a Policy vault keeps them there instead (as deployed
    /// before), and shows no settings for them. Nil until its vaults are read.
    public static func served(vaults: [AgentWire.Surface]?) -> Bool? {
        vaults.map { !$0.contains { $0.type == "vault" && $0.policyVault == true } }
    }
}

extension AgentClient {
    /// The document's text; a missing one reads as empty.
    public func policyDocument(_ document: PolicyDocument) async throws -> String {
        let value = try await decode(JSONValue.self, "GET", document.path)
        return value[document.key]?.stringValue ?? ""
    }

    /// Replaces the document; answers it as the server kept it.
    public func putPolicyDocument(_ document: PolicyDocument, _ text: String) async throws -> String {
        let value = try await decode(JSONValue.self, "PUT", document.path, json: .object([document.key: .string(text)]))
        return value[document.key]?.stringValue ?? text
    }
}
