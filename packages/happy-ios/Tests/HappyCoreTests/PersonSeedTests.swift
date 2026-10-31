import XCTest
@testable import HappyCore

final class PersonSeedTests: XCTestCase {
    func testATeamUserIsThePersonsSeed() {
        XCTAssertEqual(PersonSeed.seed(userId: "u-steve", otherwise: "person:agent:mac"), "u-steve")
        XCTAssertEqual(PersonSeed.seed(userId: nil, otherwise: "person:agent:mac"), "person:agent:mac")
        XCTAssertEqual(PersonSeed.seed(userId: "", otherwise: "person:agent:mac"), "person:agent:mac")
    }

}
