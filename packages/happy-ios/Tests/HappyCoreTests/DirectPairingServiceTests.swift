import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyWire

private func vectorBytes(_ hex: String) -> Data {
    Data(stride(from: 0, to: hex.count, by: 2).map { offset in
        let start = hex.index(hex.startIndex, offsetBy: offset)
        return UInt8(hex[start..<hex.index(start, offsetBy: 2)], radix: 16)!
    })
}

private actor PairingVectorTransport: DirectTransport {
    var requests: [(String, String, Data?)] = []
    var closed = false
    let ending: String
    let proof: Data
    var confirms = 0
    init(ending: String = "completed", proof: Data = vectorBytes("81fa0f2f506f539f4ca3f22eeeac675850f3cd902719f14799fc6519266893c9")) { self.ending = ending; self.proof = proof }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> DirectHTTPResponse {
        requests.append((path, credential, body))
        let object: [String: Any]
        if path.hasSuffix("/handshake") && method == "POST" {
            object = ["handshakeId": CanonicalBase64URL.encode(Data(repeating: 6, count: 32)), "publicKey": CanonicalBase64URL.encode(vectorBytes("ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59")), "nonce": CanonicalBase64URL.encode(Data(repeating: 5, count: 32)), "expiresAt": Date().addingTimeInterval(60).timeIntervalSince1970 * 1000]
        } else if path.hasSuffix("/reveal") { object = ["status": "verifying"] }
        else if path.hasSuffix("/reject") { object = ["status": "rejected"] }
        else if path.hasSuffix("/confirm") { confirms += 1; object = ["status": "verifying"] }
        else { object = ["status": ending, "deviceId": "dvVectorDevice", "mac": CanonicalBase64URL.encode(proof)] }
        return DirectHTTPResponse(status: 200, body: try JSONSerialization.data(withJSONObject: object))
    }
    func close() { closed = true }
    func snapshot() -> ([(String, String, Data?)], Bool) { (requests, closed) }
}

final class DirectPairingServiceTests: XCTestCase {
    private func service(_ transport: PairingVectorTransport) throws -> DirectPairingService {
        let payload: [String: Any] = ["v": 1, "a": "tcFixedVectorAddress", "p": 24781, "t": CanonicalBase64URL.encode(Data(repeating: 3, count: 32)), "n": "Unverified Mac", "e": Date().addingTimeInterval(60).timeIntervalSince1970 * 1000]
        let link = try DirectPairingLink(DirectPairingLink.prefix + CanonicalBase64URL.encode(JSONSerialization.data(withJSONObject: payload)))
        return DirectPairingService(link: link, transport: transport, crypto: try DirectPairingCrypto(privateKey: Data(repeating: 1, count: 32), nonce: Data(repeating: 4, count: 32)))
    }
    func testCommitRevealEmojiConfirmWaitAndProof() async throws {
        let transport = PairingVectorTransport(); let service = try service(transport)
        let emoji = try await service.start(deviceName: "Phone")
        XCTAssertEqual(emoji, ["🌀", "👗", "⏳", "👟"])
        let credentials = try await service.confirm()
        XCTAssertEqual(credentials.deviceToken, CanonicalBase64URL.encode(vectorBytes("05bf38156a0b81046b4e15f584760e0e8996efe81239e5efe4560fef29c20aeb")))
        let (requests, closed) = await transport.snapshot()
        XCTAssertEqual(requests.map(\.0), ["/v0/mobile-connector/handshake", "/v0/mobile-connector/handshake/reveal", "/v0/mobile-connector/handshake/confirm", "/v0/mobile-connector/handshake?wait=25"])
        XCTAssertEqual(requests[0].1, CanonicalBase64URL.encode(Data(repeating: 3, count: 32)))
        XCTAssertTrue(requests.dropFirst().allSatisfy { $0.1 == CanonicalBase64URL.encode(Data(repeating: 6, count: 32)) })
        let confirmation = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requests[2].2)) as? [String: String])
        XCTAssertEqual(confirmation["mac"], CanonicalBase64URL.encode(vectorBytes("56562cd319819213d10c33fd9e508fffb19343d84b14882ecfc550c058181d85")))
        XCTAssertTrue(closed)
    }
    func testInvalidProofNeverProducesCredentials() async throws {
        let transport = PairingVectorTransport(proof: Data(repeating: 0, count: 32)); let service = try service(transport)
        _ = try await service.start(deviceName: "Phone")
        do { _ = try await service.confirm(); XCTFail("Bad proof accepted") }
        catch { XCTAssertEqual(error as? DirectPairingError, .invalidProof) }
        await service.cancel()
    }
    func testRejectedExpiredAndCancellationAreFinal() async throws {
        for ending in ["rejected", "expired"] {
            let transport = PairingVectorTransport(ending: ending); let service = try service(transport)
            _ = try await service.start(deviceName: "Phone")
            do { _ = try await service.confirm(); XCTFail("Terminal status accepted") }
            catch { XCTAssertEqual(error as? DirectPairingError, ending == "rejected" ? .rejected : .expired) }
            await service.cancel()
        }
        let transport = PairingVectorTransport(); let service = try service(transport)
        _ = try await service.start(deviceName: "Phone"); await service.cancel()
        do { _ = try await service.confirm(); XCTFail("Cancelled handshake accepted") } catch is CancellationError { }
        let (requests, closed) = await transport.snapshot()
        XCTAssertEqual(requests.last?.0, "/v0/mobile-connector/handshake/reject"); XCTAssertTrue(closed)
    }
}