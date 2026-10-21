import Foundation

/// happy-app encryptBlob: nonce(24) || secretbox MAC(16) || ciphertext.
public enum BlobCipher {
    public static func sessionKey(dataKey: Data) -> Data {
        KeyTree.deriveKey(master: dataKey, usage: "Happy Blobs", path: ["session"])
    }
    public static func seal(_ data: Data, key: Data, random: RandomSource = SystemRandom()) throws -> Data {
        try SecretBox.sealBundle(data, key: key, random: random)
    }
    public static func open(_ data: Data, key: Data) -> Data? {
        SecretBox.openBundle(data, key: key)
    }
}
