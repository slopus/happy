import XCTest
@testable import HappyCore

final class AgentNameTests: XCTestCase {
    func testAHostNameReadsAsTheComputerNameItCameFrom() {
        XCTAssertEqual(AgentName.friendly("Steves-MacBook-Pro.local"), "Steve's MacBook Pro")
        XCTAssertEqual(AgentName.friendly("steves-macbook-pro"), "Steve's MacBook Pro")
        XCTAssertEqual(AgentName.friendly("Annes-iMac.lan"), "Anne's iMac")
        XCTAssertEqual(AgentName.friendly("Steves-Mac-mini"), "Steve's Mac mini")
        XCTAssertEqual(AgentName.friendly("build_server"), "Build Server")
    }

    func testNamesThatEndInSKeepTheirS() {
        XCTAssertEqual(AgentName.friendly("Chris-MacBook-Air"), "Chris MacBook Air")
        XCTAssertEqual(AgentName.friendly("James-iMac"), "James iMac")
    }

    func testANameAPersonChoseStays() {
        XCTAssertEqual(AgentName.friendly("Studio Mac"), "Studio Mac")
        XCTAssertEqual(AgentName.friendly("  Work laptop "), "Work laptop")
        XCTAssertEqual(AgentName.friendly("Mac"), "Mac")
        XCTAssertEqual(AgentName.friendly("devbox"), "Devbox")
    }

    func testAnAddressStaysWholeAndNothingIsTheFallback() {
        XCTAssertEqual(AgentName.friendly("192.168.1.20"), "192.168.1.20")
        XCTAssertEqual(AgentName.friendly(""), AgentName.fallback)
        XCTAssertEqual(AgentName.friendly("  "), AgentName.fallback)
    }
}
