import Foundation

/// The picture someone or something without one of its own wears: a person,
/// an account, an agent connection, a bot or a task. One of the still shader
/// avatars from shaders.craftedstudios.co bundled in HappyUI's
/// `AvatarPlaceholders` resources, picked by a hash of its ID alone, so the
/// same ID wears the same picture on every launch and every device.
public enum AvatarPlaceholder {
    /// How many pictures are bundled: the site's wall, five effects of 40.
    public static let count = 200

    /// The bundled file's name, without its `webp` extension.
    public static func name(_ index: Int) -> String {
        "avatar-placeholder-" + String(format: "%03d", index + 1)
    }

    public static let names: [String] = (0..<count).map(name)

    /// Which picture `seed` wears.
    public static func index(seed: String) -> Int {
        Int(hash(seed) % UInt32(count))
    }

    public static func name(seed: String) -> String {
        name(index(seed: seed))
    }

    /// FNV-1a over the UTF-8 bytes, then MurmurHash3's finaliser: FNV's low
    /// bits barely move for IDs that differ only in their last character,
    /// and the pick is taken from the low bits.
    static func hash(_ seed: String) -> UInt32 {
        var hash: UInt32 = 0x811C_9DC5
        for byte in seed.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 0x0100_0193
        }
        hash = (hash ^ (hash >> 16)) &* 0x85EB_CA6B
        hash = (hash ^ (hash >> 13)) &* 0xC2B2_AE35
        return hash ^ (hash >> 16)
    }
}
