#if canImport(UIKit)
import HappyLayout
import HappyStore
import UIKit

/// One measurement of the composer's text, run off the main thread with
/// TextKit 1 as Fabric measures a TextInput (`RCTTextLayoutManager`): the
/// text in the input's attributes, wrapped at the key's width with no line
/// fragment padding, laid out no further than `measureLimit`, so a long
/// paste is laid out to a line past the cap and not to its end.
///
/// TextKit objects may be used from any thread, one thread at a time;
/// these are made, used and dropped in `run()`. The attributes are an
/// immutable font and paragraph style made on main.
struct ComposerTextMeasure: @unchecked Sendable {
    let stamp: ComposerTextHeights.Stamp
    let text: String
    let attributes: [NSAttributedString.Key: Any]

    func run() -> CGFloat {
        ThreadRules.assertOffMain()
        let key = stamp.key
        let storage = NSTextStorage(string: text, attributes: attributes)
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: max(0, key.width), height: key.measureLimit))
        container.lineFragmentPadding = 0
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        // Lays out until the container is full.
        let glyphs = manager.glyphRange(for: container)
        let characters = manager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        let used = manager.usedRect(for: container)
        return key.contentHeight(usedHeight: used.height, fits: NSMaxRange(characters) >= storage.length)
    }
}
#endif
