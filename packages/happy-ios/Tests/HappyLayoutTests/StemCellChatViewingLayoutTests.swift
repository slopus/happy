import CoreGraphics
import HappyLayout
import XCTest

final class StemCellChatViewingLayoutTests: XCTestCase {
    func testPagesAreAScreenWideAndAGapApart() {
        let layout = StemCellPicturePagerLayout(size: CGSize(width: 402, height: 874), count: 4)
        XCTAssertEqual(layout.pager, CGRect(x: -10, y: 0, width: 422, height: 874))
        XCTAssertEqual(layout.contentSize, CGSize(width: 1688, height: 874))
        XCTAssertEqual(layout.page(0), CGRect(x: 10, y: 0, width: 402, height: 874))
        XCTAssertEqual(layout.page(2), CGRect(x: 854, y: 0, width: 402, height: 874))
        XCTAssertEqual(layout.offset(3), 1266)
    }

    func testThePageMostInViewIsTheIndex() {
        let layout = StemCellPicturePagerLayout(size: CGSize(width: 402, height: 874), count: 4)
        XCTAssertEqual(layout.index(at: 0, count: 4), 0)
        XCTAssertEqual(layout.index(at: 210, count: 4), 0)
        XCTAssertEqual(layout.index(at: 212, count: 4), 1)
        XCTAssertEqual(layout.index(at: 5000, count: 4), 3)
        XCTAssertEqual(layout.index(at: -300, count: 4), 0)
    }

    func testADragDownFadesTheGroundAndShrinksThePicture() {
        let rest = StemCellPictureDismissal(translation: 0, velocity: 0, height: 874)
        XCTAssertEqual(rest.groundAlpha, 1)
        XCTAssertEqual(rest.scale, 1)
        XCTAssertFalse(rest.closes)

        let half = StemCellPictureDismissal(translation: 218.5, velocity: 0, height: 874)
        XCTAssertEqual(half.progress, 0.5, accuracy: 0.0001)
        XCTAssertEqual(half.groundAlpha, 0.5, accuracy: 0.0001)
        XCTAssertEqual(half.scale, 0.9, accuracy: 0.0001)
        XCTAssertTrue(half.closes)

        let far = StemCellPictureDismissal(translation: -600, velocity: 0, height: 874)
        XCTAssertEqual(far.groundAlpha, 0)
        XCTAssertEqual(far.scale, 0.8, accuracy: 0.0001)
        XCTAssertTrue(far.closes, "up closes too")
    }

    func testLetGoShortItStaysUnlessFlung() {
        XCTAssertFalse(StemCellPictureDismissal(translation: 60, velocity: 200, height: 874).closes)
        XCTAssertTrue(StemCellPictureDismissal(translation: 40, velocity: 1200, height: 874).closes)
        XCTAssertFalse(StemCellPictureDismissal(translation: 5, velocity: 1200, height: 874).closes, "a tap's wobble")
        XCTAssertFalse(StemCellPictureDismissal(translation: 160, velocity: -1200, height: 874).closes, "flung back")
    }

    /// Home's scrim, whole from the card's top to the foot and feathered
    /// over the 36 above it, and the way back above the list's end, over
    /// the feather (drawn in front of it).
    func testHomesScrimUnderTheCardAndTheWayBackAboveIt() {
        // iPhone 17 Pro, keyboard down: a 64 card 8 above the 34 home indicator.
        let size = CGSize(width: 402, height: 874)
        let card = CGRect(x: 8, y: 768, width: 386, height: 64)
        let layout = StemCellChatFootLayout(size: size, card: card)
        XCTAssertEqual(layout.scrim, CGRect(x: 0, y: 732, width: 402, height: 142))
        XCTAssertEqual(card.minY - layout.scrim.minY, HeaderScrim.rampPoints)
        XCTAssertEqual(layout.jump, CGRect(x: 185, y: 716, width: 32, height: 32))
        XCTAssertLessThanOrEqual(layout.jump.maxY, card.minY - 8)
    }

    func testTheWayBackShowsPastAThirdOfTheList() {
        XCTAssertFalse(StemCellChatFootLayout.showsJump(distanceFromEnd: 200, viewport: 600))
        XCTAssertTrue(StemCellChatFootLayout.showsJump(distanceFromEnd: 201, viewport: 600))
        XCTAssertFalse(StemCellChatFootLayout.showsJump(distanceFromEnd: 0, viewport: -40), "no list to be away from")
    }
}
