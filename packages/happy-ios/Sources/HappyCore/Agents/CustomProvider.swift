import Foundation
import HappyWire

/// A team's own inference provider on Happy Cloud (`PUT /v0/providers/:id`,
/// owners with `providers.manage`): an endpoint speaking OpenAI's Responses
/// API, the one protocol Happy Cloud serves today, with one model and the
/// team's key. The key is sent once with it and never comes back. Desktop's
/// HappyAgentCustomProviderDialog edits the rest (more models, other
/// protocols, the prompt cache key).
public struct CustomProvider: Equatable, Sendable {
    public var name: String
    public var baseUrl: String
    public var model: String
    public var apiKey: String

    public init(name: String, baseUrl: String, model: String, apiKey: String) {
        self.name = name; self.baseUrl = baseUrl; self.model = model; self.apiKey = apiKey
    }

    /// The IDs the server keeps for its own providers and their types: a
    /// team's never takes one.
    static let reserved: Set<String> = ["openai", "anthropic", "grok", "bedrock", "codex", "claude-code", "openai-compatible", "private", "team"]

    /// Its ID, made from its name as desktop does: lowercase, runs of
    /// anything else as one `-`, 2 to 32 long, starting with a letter, never
    /// a built-in one's.
    public var id: String {
        var slug = ""
        for scalar in name.lowercased().unicodeScalars {
            if ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) { slug.unicodeScalars.append(scalar) }
            else if !slug.isEmpty, !slug.hasSuffix("-") { slug.append("-") }
        }
        while let first = slug.unicodeScalars.first, !("a"..."z").contains(first) { slug.removeFirst() }
        slug = String(slug.prefix(32))
        while slug.hasSuffix("-") { slug.removeLast() }
        if slug.count < 2 { slug = "custom" + (slug.isEmpty ? "" : "-" + slug) }
        if Self.reserved.contains(slug) { slug = String((slug + "-custom").prefix(32)) }
        return slug
    }

    /// Every part filled in, the address an https URL.
    public var isComplete: Bool {
        let address = baseUrl.trimmingCharacters(in: .whitespaces)
        guard let url = URL(string: address), url.scheme?.lowercased() == "https", url.host?.isEmpty == false else { return false }
        return [name, model, apiKey].allSatisfy { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    var body: JSONValue {
        let model = model.trimmingCharacters(in: .whitespaces)
        return .object([
            "name": .string(name.trimmingCharacters(in: .whitespaces)),
            "baseUrl": .string(baseUrl.trimmingCharacters(in: .whitespaces)),
            "protocol": .string("openai_responses"),
            "models": .array([.object(["id": .string(model), "name": .string(model), "inputTypes": .array([.string("text")])])]),
            "apiKey": .string(apiKey.trimmingCharacters(in: .whitespaces)),
        ])
    }
}

extension AgentClient {
    /// Adds (or replaces) the team's own provider and its key.
    public func putCustomProvider(_ provider: CustomProvider) async throws {
        _ = try await send("PUT", "/v0/providers/\(Self.escape(provider.id))", json: provider.body)
    }
}
