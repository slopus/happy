import Foundation
import HappyCrypto
import HappyWire

/// The account owns the encrypted disk cache, decoded LRU and in-flight
/// coalescing. There is no database read or key work when a chat is tapped.
@MainActor
public final class AvatarPictures {
    public typealias Decode = AccountPictures.Decode<Data>
    private let cache: AccountPictures
    private let loader: AvatarPictureLoader

    public nonisolated init(owner: String, directory: URL?, api: HappyAPI, keys: AccountKeys) {
        cache = AccountPictures(owner: owner, directory: directory, fetch: { _, _ in nil }, maxCount: 256, maxFiles: 512)
        loader = AvatarPictureLoader(api: api, keys: keys)
    }

    public func cached(_ source: AvatarImageSource) -> AccountPictures.Picture? { cache.cached(key: source.cacheKey) }

    public func picture(_ source: AvatarImageSource, decode: @escaping Decode) async -> AccountPictures.Picture? {
        if let image = await primaryPicture(source, decode: decode) { return image }
        guard !Task.isCancelled, let project = source.fallbackProject else { return nil }
        return await primaryPicture(project.source, decode: decode)
    }

    private func primaryPicture(_ source: AvatarImageSource, decode: @escaping Decode) async -> AccountPictures.Picture? {
        let loader = self.loader
        // Resolve keys and decrypt preview on a detached task, even on hits.
        guard let key = await Task.detached(priority: .utility, operation: { loader.key(for: source) }).value else { return nil }
        return await cache.picture(key: source.cacheKey, fetch: {
            try? await loader.api.downloadAvatar(source)
        }, decode: { encrypted in
            guard let bytes = BlobCipher.open(encrypted, key: key) else { return nil }
            return decode(bytes)
        })
    }

    public func removeAll() { cache.removeAll() }
    public func close() async { await cache.close() }
}

struct AvatarPictureLoader: Sendable {
    let api: HappyAPI
    let keys: AccountKeys

    func key(for source: AvatarImageSource) -> Data? {
        let ring = KeyRing(keys: keys)
        let preview: JSONValue?
        let blobKey: Data?
        if source.scope == .project, source.dataKeyCipher == nil {
            preview = AccountCipher(secret: keys.secret).decrypt(base64: source.descriptor.preview)
            blobKey = KeyTree.deriveKey(master: keys.secret, usage: "Happy Blobs", path: ["master"])
        } else {
            preview = ring.cipher(wrappedKey: source.dataKeyCipher)?.decrypt(base64: source.descriptor.preview)
            blobKey = ring.blobKey(wrappedKey: source.dataKeyCipher)
        }
        guard let hash = preview?["thumbhash"]?.stringValue, !hash.isEmpty, hash.count <= 128,
              let mime = preview?["mimeType"]?.stringValue,
              ["image/png", "image/jpeg", "image/webp"].contains(mime) else { return nil }
        return blobKey
    }
}
