import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

public enum Hashing {
    public static func sha512(_ data: Data) -> Data {
        Data(SHA512.hash(data: data))
    }

    public static func sha256(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }

    public static func hmacSHA512(key: Data, data: Data) -> Data {
        Data(HMAC<SHA512>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }
}

/// The HMAC-SHA512 key tree every Happy client derives its keys from
/// (packages/happy-app/sources/encryption/deriveKey.ts).
///
///     root  = HMAC-SHA512(key: "<usage> Master Seed", data: seed)
///     child = HMAC-SHA512(key: parent.chainCode, data: 0x00 || index)
///
/// The first 32 bytes of each step are the key, the last 32 the chain code.
public enum KeyTree {
    public struct State: Sendable, Equatable {
        public let key: Data
        public let chainCode: Data
    }

    public static func root(seed: Data, usage: String) -> State {
        split(Hashing.hmacSHA512(key: Data((usage + " Master Seed").utf8), data: seed))
    }

    public static func child(chainCode: Data, index: String) -> State {
        var data = Data([0x00])
        data.append(Data(index.utf8))
        return split(Hashing.hmacSHA512(key: chainCode, data: data))
    }

    public static func deriveKey(master: Data, usage: String, path: [String]) -> Data {
        var state = root(seed: master, usage: usage)
        for index in path {
            state = child(chainCode: state.chainCode, index: index)
        }
        return state.key
    }

    private static func split(_ digest: Data) -> State {
        State(key: Data(digest.prefix(32)), chainCode: Data(digest.suffix(32)))
    }
}
