import Foundation
import XCTest
@testable import HappyLayout

final class AgentIdentityLayoutTests: XCTestCase {
    func testExactMeasuredFrames() {
        let layout = AgentIdentityLayout(width: 320, title: Measurable { _ in CGSize(width: 320, height: 30) }, body: Measurable { _ in CGSize(width: 320, height: 90) }, emoji: Measurable { _ in CGSize(width: 320, height: 60) })
        XCTAssertEqual(layout.image, CGRect(x: 116, y: 0, width: 88, height: 88))
        XCTAssertEqual(layout.title, CGRect(x: 0, y: 108, width: 320, height: 30))
        XCTAssertEqual(layout.body, CGRect(x: 0, y: 150, width: 320, height: 90))
        XCTAssertEqual(layout.emoji, CGRect(x: 0, y: 260, width: 320, height: 60))
        XCTAssertEqual(layout.size, CGSize(width: 320, height: 332))
    }
    func testSingleLogoAndMultipleAccountAvatar() {
        var input = HomeHeaderLayout.Input(width: 390, safeTop: 59, hairline: 0.5, title: Measurable { _ in CGSize(width: 90, height: 20) }, status: nil)
        XCTAssertEqual(HomeHeaderLayout(input).logo.size, CGSize(width: 19, height: 19))
        input.showsAccountAvatar = true
        let avatar = HomeHeaderLayout(input)
        XCTAssertEqual(avatar.logo, CGRect(x: 22, y: 69, width: 32, height: 32))
        XCTAssertEqual(avatar.logo.midX, avatar.logoControl.midX)
    }
}