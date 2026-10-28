#if os(macOS)
import AppKit
import HappyCore
import HappyLayout
import ScreenCaptureKit
import XCTest
@testable import HappyMac

final class MacWindowTests: XCTestCase {
    @MainActor
    func testTrueAppKitWindowAndSDK() throws {
        let controller = try XCTUnwrap((NSApp.delegate as? MacAppDelegate)?.controller)
        let window = try XCTUnwrap(controller.window)
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "DTPlatformName") as? String, "macosx")
        XCTAssertTrue(window.contentView is MacRootView)
        XCTAssertEqual(window.contentMinSize, MacDesktopLayout.minimumSize)
        XCTAssertTrue(window.styleMask.contains(.resizable))
        XCTAssertNil(NSClassFromString("UIApplication"))
    }

    @MainActor
    func testNativeEditorAndMenus() throws {
        let controller = try XCTUnwrap((NSApp.delegate as? MacAppDelegate)?.controller)
        XCTAssertFalse(controller.root.conversation.composer.isRichText)
        XCTAssertNotNil(NSApp.mainMenu?.item(withTitle: "Edit"))
        XCTAssertNotNil(NSApp.windowsMenu)
        XCTAssertEqual(controller.root.sidebar.search.placeholderString, "Search sessions")
    }

    @MainActor
    func testNativeTextEditingKeepsTheDraft() throws {
        let controller = try XCTUnwrap((NSApp.delegate as? MacAppDelegate)?.controller)
        let window = try XCTUnwrap(controller.window)
        let editor = controller.root.conversation.composer
        let previous = (controller.root.conversation.isHidden, controller.root.welcome.isHidden, editor.isEditable, editor.string)
        defer {
            editor.string = previous.3; editor.isEditable = previous.2
            controller.root.welcome.isHidden = previous.1; controller.root.conversation.isHidden = previous.0
            window.makeFirstResponder(nil)
        }
        controller.root.welcome.isHidden = true; controller.root.conversation.isHidden = false
        editor.isEditable = true; editor.string = ""
        controller.root.layoutSubtreeIfNeeded()
        XCTAssertTrue(window.makeFirstResponder(editor))
        editor.insertText("A native Mac draft", replacementRange: NSRange(location: 0, length: 0))
        XCTAssertEqual(editor.string, "A native Mac draft")
        editor.selectAll(nil)
        XCTAssertEqual(editor.selectedRange().length, editor.string.utf16.count)
    }

    @MainActor
    func testCaptureActualAppKitWindow() async throws {
        try await Task.sleep(for: .milliseconds(500))
        let controller = try XCTUnwrap((NSApp.delegate as? MacAppDelegate)?.controller)
        let window = try XCTUnwrap(controller.window)
        let size = try XCTUnwrap(window.contentView).bounds.size
        defer { window.setContentSize(size) }
        window.setContentSize(NSSize(width: 1180, height: 780))
        try await Task.sleep(for: .milliseconds(150))
        try await capture(window, name: "Happy AppKit — welcome")
        window.setContentSize(NSSize(width: 920, height: 640))
        try await Task.sleep(for: .milliseconds(150))
        try await capture(window, name: "Happy AppKit — compact window")
    }

    @MainActor
    private func capture(_ window: NSWindow, name: String) async throws {
        guard #available(macOS 14.4, *) else { throw XCTSkip("Own-process capture requires macOS 14.4") }
        window.contentView?.layoutSubtreeIfNeeded()
        // This API only exposes our process's windows and does not prompt for TCC.
        let content = try await SCShareableContent.currentProcess
        let ownWindow = try XCTUnwrap(content.windows.first { $0.windowID == CGWindowID(window.windowNumber) })
        let filter = SCContentFilter(desktopIndependentWindow: ownWindow)
        let configuration = SCStreamConfiguration()
        configuration.width = Int(window.frame.width * window.backingScaleFactor)
        configuration.height = Int(window.frame.height * window.backingScaleFactor)
        let captured = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        let image = NSBitmapImageRep(cgImage: captured)
        let data = try XCTUnwrap(image.representation(using: .png, properties: [:]))
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.png")
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
#endif