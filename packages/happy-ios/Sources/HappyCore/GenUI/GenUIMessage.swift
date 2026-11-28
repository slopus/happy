import Foundation
import HappyWire

/// Direct message presentations have no artifact authority or file namespace.
public enum GenUIMessage {
    public static func document(_ json: JSONValue?) -> GenUIRenderDocument {
        guard let json, json.objectValue != nil else {
            return GenUIRenderDocument(fallback: "Gen UI", root: nil, elements: [:])
        }
        // Unlike old artifact documents, this new contract requires a version.
        guard json["genuiRender"]?.numberValue == 1,
              (json["elements"]?.objectValue?.count ?? 0) <= GenUIRenderDocument.maxElements,
              !(json["elements"]?.objectValue?.values.contains { $0["type"]?.stringValue == "image" } ?? false),
              let bytes = try? JSONEncoder().encode(json), bytes.count <= 4 * 1024 * 1024,
              var parsed = GenUIRenderDocument.parse(json) else {
            return GenUIRenderDocument(fallback: fallback(json["fallback"]?.stringValue), root: nil, elements: [:])
        }
        parsed.fallback = fallback(parsed.fallback)
        return parsed
    }

    private static func fallback(_ text: String?) -> String {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "Gen UI" }
        return text
    }

    /// `plugin` only opens the plugin's page, and only where the server
    /// serves plugins (`GenUIHost.enables`); it never reports a setup here.
    public static func enables(_ action: GenUIAction) -> Bool {
        switch action {
        case .message, .copy, .plugin: true
        case .open(let address): safeURL(address)
        case .tool, .secret, .clusterSecret, .unsupported: false
        }
    }

    private static func safeURL(_ address: String) -> Bool {
        guard address.lowercased().hasPrefix("https://"), !address.contains("\\"),
              !address.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }),
              let url = URLComponents(string: address), url.scheme?.lowercased() == "https",
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return false }
        return true
    }
}