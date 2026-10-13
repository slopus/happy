import Foundation
import XCTest
import HappyCrypto

final class BlobCipherTests: XCTestCase {
    func testNodeSessionKeyDerivation() throws {
        struct Fixture: Decodable {
            let dataKey: String
            let blobKey: String
        }
        let url = try XCTUnwrap(Bundle.module.url(forResource: "blob-keys", withExtension: "json", subdirectory: "Fixtures"))
        let fixtures = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: url))
        for fixture in fixtures {
            XCTAssertEqual(BlobCipher.sessionKey(dataKey: b64(fixture.dataKey)), b64(fixture.blobKey))
        }
    }

    func testTweetnaclRawBlobBundles() throws {
        for vector in try Vectors.load().secretBox {
            let plaintext = b64(vector.plaintext)
            let key = b64(vector.key)
            let random = FixedNonce(data: b64(vector.nonce))
            XCTAssertEqual(try BlobCipher.seal(plaintext, key: key, random: random), b64(vector.bundle))
            XCTAssertEqual(BlobCipher.open(b64(vector.bundle), key: key), plaintext)
            var corrupted = b64(vector.bundle)
            corrupted[corrupted.count - 1] ^= 1
            XCTAssertNil(BlobCipher.open(corrupted, key: key))
        }
    }
}

private struct FixedNonce: RandomSource {
    let data: Data
    func bytes(_ count: Int) -> Data { Data(data.prefix(count)) }
}
