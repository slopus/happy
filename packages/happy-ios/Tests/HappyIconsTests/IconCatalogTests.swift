import HappyIcons
import XCTest

final class IconCatalogTests: XCTestCase {
    func testIconsAreNamedLikeTheRNCode() {
        XCTAssertEqual(Icon.ionicons("chevron-forward"), Icon(.ionicons, "chevron-forward"))
        XCTAssertEqual(IconFamily.materialCommunityIcons.rawValue, "MaterialCommunityIcons")
    }
}
