import Foundation
import HappyLayout
import XCTest

final class BrowserLayoutTests: XCTestCase {
    func testPhoneWithProxyIndicator() {
        let result = BrowserLayout(size: CGSize(width: 393, height: 852), top: 103, bottom: 34, showsRoute: true)
        XCTAssertEqual(result.progress, CGRect(x: 0, y: 103, width: 393, height: 2))
        XCTAssertEqual(result.status, CGRect(x: 0, y: 105, width: 393, height: 24))
        XCTAssertEqual(result.web, CGRect(x: 0, y: 129, width: 393, height: 639))
        XCTAssertEqual(result.toolbar, CGRect(x: 0, y: 768, width: 393, height: 84))
    }
    func testDirectAndCompact() {
        let result = BrowserLayout(size: CGSize(width: 852, height: 393), top: 44, bottom: 21, showsRoute: false)
        XCTAssertEqual(result.web, CGRect(x: 0, y: 46, width: 852, height: 276))
        XCTAssertEqual(result.toolbar, CGRect(x: 0, y: 322, width: 852, height: 71))
        XCTAssertEqual(result.status.height, 0)
    }
}