#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit

/// One Gen UI render document (`-genui 01-stats`) as a block of an agent's
/// message: on the agents' chat ground, inside the chat's margins, nothing
/// else on screen, for screenshots. The documents and their
/// images are `Tests/HappyCoreTests/Fixtures/GenUI`, bundled as a folder.
/// Once the images are in it writes the block's frame in window points to
/// `tmp/genui-frame.json` in the app's container and prints it as
/// `GENUI_FRAME {json}`, so a script can crop to it.
///
/// `-genuiFile <path>` draws any render document instead, read when the app
/// starts, so a new one needs no rebuild: a path relative to the app's home
/// (push it with `simctl get_app_container … data`) or an absolute one. Its
/// `assets/…` images still come from the bundled folder. Taps print
/// `GENUI_ACTION <key> <action>` and are never run.
@MainActor
final class GenUIHarness {
    private let block = GenUIBlockView()

    init(window: UIWindow, fixture: String? = nil, file: String? = nil) {
        let folder = Bundle.main.resourceURL!.appendingPathComponent("GenUI")
        let url: URL
        if let file {
            url = file.hasPrefix("/") ? URL(fileURLWithPath: file) : URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(file)
        } else {
            url = folder.appendingPathComponent("\(fixture ?? "").render.json")
        }
        let document = (try? Data(contentsOf: url)).flatMap(GenUIRenderDocument.parse)
            ?? GenUIRenderDocument(fallback: "Can't read a Gen UI render document at \(url.path)", root: nil, elements: [:])
        block.interaction.onAction = { print("GENUI_ACTION \($0) \($1)") }
        block.interaction.onViewer = { print("GENUI_VIEWER \($0) \($1) \($2)") }
        let controller = UIViewController()
        controller.view.backgroundColor = UIColor(Palette.surface)
        let scroll = UIScrollView()
        scroll.contentInsetAdjustmentBehavior = .always
        controller.view.addSubview(scroll)
        scroll.addSubview(block)
        window.rootViewController = controller
        window.layoutIfNeeded()
        scroll.frame = controller.view.bounds
        let margin = MessageLayout.Metrics.marginH
        let width = scroll.bounds.width - 2 * margin
        block.onHeight = { [block] height in
            // A message's own margin above it, as the first block of a row.
            block.frame = CGRect(x: margin, y: margin, width: width, height: height)
            scroll.contentSize = CGSize(width: scroll.bounds.width, height: height + 2 * margin)
            // `-genuiOffset <points>` scrolls a block taller than the screen
            // that far, for a second screenshot of its foot.
            let arguments = ProcessInfo.processInfo.arguments
            if let index = arguments.firstIndex(of: "-genuiOffset"), arguments.indices.contains(index + 1), let offset = Double(arguments[index + 1]) {
                scroll.layoutIfNeeded()
                scroll.contentOffset.y = -scroll.adjustedContentInset.top + offset
                scroll.contentSize.height += offset
            }
        }
        block.load(document, width: width, traits: GenUITraits(text: nil, displayScale: window.screen.scale), files: GenUIFolderFiles(folder: folder), runs: .reporting)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [block] in
            let frame = block.convert(block.bounds, to: nil)
            let json = #"{"x":\#(frame.minX),"y":\#(frame.minY),"width":\#(frame.width),"height":\#(frame.height),"scale":\#(window.screen.scale)}"#
            try? json.write(to: FileManager.default.temporaryDirectory.appendingPathComponent("genui-frame.json"), atomically: true, encoding: .utf8)
            print("GENUI_FRAME \(json)")
        }
    }

    /// `-genuiFixtures [name]`: Settings' Gen UI fixtures screen, as a
    /// device shows it, with `name` opened when given. Two seconds in it
    /// writes the window to `Documents/genui-fixtures.png` in the app's
    /// container, for `devicectl device copy from`.
    static func fixtures(window: UIWindow, open name: String?) {
        let list = GenUIFixturesViewController()
        let navigation = UINavigationController(rootViewController: list)
        window.rootViewController = navigation
        if let name { navigation.pushViewController(GenUIFixtureViewController(name: name), animated: false) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            try? image.pngData()?.write(to: documents.appendingPathComponent("genui-fixtures.png"))
            print("GENUI_FIXTURES_SHOT")
        }
    }
}
#endif
