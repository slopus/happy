import Foundation
@testable import HappyCore
import Tailcat
import XCTest

final class TailcatConfigurationTests: XCTestCase {
    func testRelayFirstPreservesEachClientsNodeKeyAndTimeout() throws {
        let keys = try (0..<3).map { _ in try NodePrivateKey.generate() }
        for key in keys {
            let config = AgentHTTPTransport.tailcatConfiguration(key: key)
            XCTAssertTrue(config.relayFirst)
            XCTAssertEqual(config.connectTimeout, 20)
            XCTAssertEqual(try config.privateKey?.publicKey.rawValue, try key.publicKey.rawValue)
            XCTAssertEqual((config.mapCache as? FileDERPMapCache)?.directory.lastPathComponent, "tailcat")
        }
        XCTAssertEqual(try Set(keys.map { try $0.publicKey.rawValue }).count, 3)
    }
}