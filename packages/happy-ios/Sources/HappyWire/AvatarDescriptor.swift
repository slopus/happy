import Foundation

/// Private artwork: the preview is encrypted JSON, never a URL or thumbhash.
public struct AvatarDescriptor: Codable, Hashable, Sendable {
    public let ref: String
    public let preview: String
    public let version: Int

    public init(ref: String, preview: String, version: Int) {
        self.ref = ref
        self.preview = preview
        self.version = version
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ref = try c.decode(String.self, forKey: .ref)
        preview = try c.decode(String.self, forKey: .preview)
        version = try c.decode(Int.self, forKey: .version)
        guard !ref.isEmpty, ref.utf8.count <= 1024, !preview.isEmpty,
              preview.utf8.count <= 4096, version > 0 else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid avatar descriptor"))
        }
    }
}
