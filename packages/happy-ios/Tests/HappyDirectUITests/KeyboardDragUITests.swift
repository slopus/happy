import XCTest

extension UITests {
    /// Measures every frame while a real keyboard is held partway down.
    /// A check after release misses a composer left at the resting edge.
    func testComposerTracksHeldKeyboardDrag() {
        checkComposerTracksHeldKeyboardDrag()
    }
}