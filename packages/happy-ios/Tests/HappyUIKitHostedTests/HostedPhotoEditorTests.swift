#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The "+" menu's editor, Telegram's crop and brushes: what it applies is
/// the picture everywhere (the grid, the preview, what is sent), and an
/// edit picks its picture. The drawing is the photo's own pixels, so a
/// crop turns and cuts it and the eraser takes a stroke back out.
@MainActor
final class HostedPhotoEditorTests: XCTestCase {
    private var window: UIWindow?

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        try await super.tearDown()
    }

    private func views(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(views) }

    private func wait(_ seconds: Double = 5, _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), "never reached the expected state", file: file, line: line)
    }

    private func control(_ id: String, in view: UIView) throws -> UIControl {
        try XCTUnwrap(views(view).compactMap { $0 as? UIControl }.first { $0.accessibilityIdentifier == id }, id)
    }

    private func menu() async throws -> AttachSheetViewController {
        let root = UIViewController()
        window = hostedKeyWindow(in: try await hostedActiveScene(), root: root)
        let sheet = AttachSheetViewController(limit: 10, library: FixtureAttachLibrary(access: .authorized, count: 6), camera: false)
        root.present(sheet, animated: false)
        try await wait { sheet.feed.count == 6 }
        return sheet
    }

    private func preview(_ sheet: AttachSheetViewController, at index: Int) async throws -> AttachPreviewViewController {
        sheet.feed.onOpen?(index)
        try await wait { sheet.presentedViewController is AttachPreviewViewController }
        let preview = try XCTUnwrap(sheet.presentedViewController as? AttachPreviewViewController)
        try await wait { preview.shown }
        return preview
    }

    /// A 16:9 crop from the preview's Crop: the photo is picked, its
    /// tool turns yellow, and what is read is 16:9.
    func testACropAppliedIsWhatIsSentAndPicksThePhoto() async throws {
        let sheet = try await menu()
        let preview = try await preview(sheet, at: 2)
        let id = try XCTUnwrap(sheet.library.item(at: 2)?.id)
        XCTAssertTrue(sheet.picked.isEmpty)
        try control("attach-preview-crop", in: preview.view).sendActions(for: .touchUpInside)
        try await wait { preview.presentedViewController is PhotoCropViewController }
        let crop = try XCTUnwrap(preview.presentedViewController as? PhotoCropViewController)
        crop.loadViewIfNeeded()
        crop.onDone?(crop.crop.with(aspect: PhotoAspect(16, 9), in: crop.canvas))
        try await wait { preview.presentedViewController == nil }
        XCTAssertEqual(sheet.picked, [id])
        XCTAssertEqual(preview.shownNumber, 1)
        XCTAssertTrue(try XCTUnwrap(try control("attach-preview-crop", in: preview.view) as? PhotoEditorButton).applied)
        let picks = await sheet.library.read([id])
        let read = try XCTUnwrap(picks.first)
        XCTAssertEqual(read.pixelSize.width / read.pixelSize.height, 16.0 / 9, accuracy: 0.01)
        guard case .image(_, let type) = read.media else { return XCTFail("not an image") }
        XCTAssertEqual(type, .jpeg)
    }

    /// Cancel keeps the picture as it was, and doesn't pick it.
    func testCancelledLeavesThePhotoAlone() async throws {
        let sheet = try await menu()
        let preview = try await preview(sheet, at: 0)
        try control("attach-preview-draw", in: preview.view).sendActions(for: .touchUpInside)
        try await wait { preview.presentedViewController is PhotoDrawViewController }
        let draw = try XCTUnwrap(preview.presentedViewController as? PhotoDrawViewController)
        draw.loadViewIfNeeded()
        XCTAssertEqual(draw.currentTool, .arrow, "the editor opens on the arrow")
        draw.onCancel?()
        try await wait { preview.presentedViewController == nil }
        XCTAssertTrue(sheet.picked.isEmpty)
        XCTAssertNil(sheet.edits.edit(try XCTUnwrap(sheet.library.item(at: 0)?.id)))
    }

    /// Strokes from Draw are kept with the photo and pick it; the grid's
    /// cell shows the drawn picture.
    func testStrokesAreKeptAndShowInTheGrid() async throws {
        let sheet = try await menu()
        let id = try XCTUnwrap(sheet.library.item(at: 0)?.id)
        let first = await thumbnail(sheet.library, 0)
        let before = try XCTUnwrap(first)
        let preview = try await preview(sheet, at: 0)
        try control("attach-preview-draw", in: preview.view).sendActions(for: .touchUpInside)
        try await wait { preview.presentedViewController is PhotoDrawViewController }
        let draw = try XCTUnwrap(preview.presentedViewController as? PhotoDrawViewController)
        let stroke = PhotoStroke(tool: .pen, color: RGBA(red: 1, green: 0, blue: 0), width: 200, points: [CGPoint(x: 0, y: 1000), CGPoint(x: 2048, y: 1000)])
        draw.onDone?([stroke])
        try await wait { preview.presentedViewController == nil }
        XCTAssertEqual(sheet.edits.edit(id)?.strokes, [stroke])
        XCTAssertEqual(sheet.picked, [id])
        let second = await thumbnail(sheet.library, 0)
        let after = try XCTUnwrap(second)
        XCTAssertNotEqual(before.pngData(), after.pngData(), "the cell's picture is the drawn one")
    }

    private func thumbnail(_ library: AttachLibrary, _ index: Int) async -> UIImage? {
        await withCheckedContinuation { continuation in
            var done = false
            _ = library.thumbnail(at: index, pixels: CGSize(width: 256, height: 256)) { image in
                guard !done else { return }
                done = true
                continuation.resume(returning: image)
            }
        }
    }

    // MARK: The renderer

    private func solid(_ size: CGSize, _ color: UIColor) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            color.setFill()
            UIRectFill(CGRect(origin: .zero, size: size))
        }
    }

    private func pixel(_ image: UIImage, _ point: CGPoint) -> RGBA {
        let cg = image.cgImage!
        var bytes = [UInt8](repeating: 0, count: 4)
        let context = CGContext(data: &bytes, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(cg, in: CGRect(x: -point.x, y: point.y - CGFloat(cg.height) + 1, width: CGFloat(cg.width), height: CGFloat(cg.height)))
        return RGBA(red: Double(bytes[0]) / 255, green: Double(bytes[1]) / 255, blue: Double(bytes[2]) / 255, alpha: Double(bytes[3]) / 255)
    }

    /// A quarter turn makes a wide picture tall; a mirror flips which side
    /// a stroke is on.
    func testTheRendererTurnsAndFlips() {
        let canvas = CGSize(width: 400, height: 200)
        let picture = solid(canvas, .blue)
        let stroke = PhotoStroke(tool: .pen, color: RGBA(red: 1, green: 0, blue: 0), width: 40, points: [CGPoint(x: 20, y: 0), CGPoint(x: 20, y: 200)])
        var edit = PhotoEdit(canvas: canvas, strokes: [stroke])
        let flat = PhotoEditRenderer.render(picture, edit)
        XCTAssertEqual(flat.size, canvas)
        XCTAssertGreaterThan(pixel(flat, CGPoint(x: 20, y: 100)).red, 0.9)
        edit.crop = edit.crop.rotatedLeft()
        let turned = PhotoEditRenderer.render(picture, edit)
        XCTAssertEqual(turned.size, CGSize(width: 200, height: 400))
        // Turned left, the picture's left edge is the bottom.
        XCTAssertGreaterThan(pixel(turned, CGPoint(x: 100, y: 380)).red, 0.9)
        edit.crop = PhotoCrop.whole(canvas)
        edit.crop.mirrored = true
        let flipped = PhotoEditRenderer.render(picture, edit)
        XCTAssertGreaterThan(pixel(flipped, CGPoint(x: 380, y: 100)).red, 0.9)
        XCTAssertLessThan(pixel(flipped, CGPoint(x: 20, y: 100)).red, 0.1)
    }

    /// The eraser takes strokes out, never the photo.
    func testTheEraserTakesOutOnlyTheDrawing() {
        let canvas = CGSize(width: 200, height: 200)
        let picture = solid(canvas, .blue)
        let line = PhotoStroke(tool: .pen, color: RGBA(red: 1, green: 0, blue: 0), width: 40, points: [CGPoint(x: 0, y: 100), CGPoint(x: 200, y: 100)])
        let rub = PhotoStroke(tool: .eraser, color: .white, width: 60, points: [CGPoint(x: 100, y: 0), CGPoint(x: 100, y: 200)])
        let out = PhotoEditRenderer.render(picture, PhotoEdit(canvas: canvas, strokes: [line, rub]))
        XCTAssertGreaterThan(pixel(out, CGPoint(x: 20, y: 100)).red, 0.9)
        let erased = pixel(out, CGPoint(x: 100, y: 100))
        XCTAssertLessThan(erased.red, 0.1)
        XCTAssertGreaterThan(erased.blue, 0.9)
    }

    /// Telegram's widths: the pen 0.2% to 7% of the longer side, the marker 1% to 9%.
    func testBrushWidthsFollowTelegram() {
        let canvas = CGSize(width: 2048, height: 1024)
        XCTAssertEqual(PhotoEditRenderer.width(0, tool: .pen, canvas: canvas), 4.096, accuracy: 0.001)
        XCTAssertEqual(PhotoEditRenderer.width(1, tool: .pen, canvas: canvas), 143.36, accuracy: 0.01)
        XCTAssertEqual(PhotoEditRenderer.width(0, tool: .marker, canvas: canvas), 20.48, accuracy: 0.01)
        XCTAssertEqual(PhotoEditRenderer.width(1, tool: .marker, canvas: canvas), 184.32, accuracy: 0.01)
    }
}
#endif
