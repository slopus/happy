#if canImport(UIKit)
import AVFoundation
import HappyCore
@testable import HappyUI
import Photos
import UIKit
import XCTest

private struct VideoTestComputer: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.notConnectedToInternet)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.notConnectedToInternet)
    }
    func reset() async {}
    func close() async {}
}

/// Exercises the actual + menu and its PhotoKit grid against a video in Photos. Run
/// on a throwaway simulator with full Photos access granted to the UIKit test
/// host. Removing that simulator also removes the generated library fixture.
@MainActor
final class HostedComposerVideoTests: XCTestCase {
    func testPlusAttachesVideoFromTheMenusGrid() async throws {
        try XCTSkipUnless(PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized,
            "Grant full Photos access to the test host on a throwaway simulator")
        let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension("mov")
        defer { try? FileManager.default.removeItem(at: source) }
        try await makeVideo(at: source)
        let created = Date()
        try await PHPhotoLibrary.shared().performChanges { @Sendable in
            PHAssetCreationRequest.creationRequestForAssetFromVideo(atFileURL: source)?.creationDate = created
        }
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "mediaType == %d AND creationDate >= %@", PHAssetMediaType.video.rawValue, created as NSDate)
        let asset = try XCTUnwrap(PHAsset.fetchAssets(with: options).firstObject)

        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "video-test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil, agentTransport: { _ in VideoTestComputer() })
        await account.agentConnections.setForeground(false)
        let computer = try await account.agentConnections.add(JSONDecoder().decode(AgentConnectionCredentials.self,
            from: Data(#"{"address":"video-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"test"}"#.utf8)), name: "Video test")
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try await account.agentConnections.remove(computer.id)
        }
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        let chat = ChatViewController(session: session, agentId: "video-test", title: "Video attachment", spaceId: nil, intro: nil)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: chat)
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        let card = try XCTUnwrap(subviews(chat.view).compactMap { $0 as? AgentInputCardView }.first)

        // Tap the composer's actual +, then pick the video, newest, in its grid.
        try plus(in: card).sendActions(for: .touchUpInside)
        try await wait { chat.presentedViewController is AttachSheetViewController }
        let sheet = try XCTUnwrap(chat.presentedViewController as? AttachSheetViewController)
        let grid = try XCTUnwrap(subviews(sheet.view).first { $0.accessibilityIdentifier == "attach-grid" } as? UICollectionView)
        try await wait { grid.visibleCells.contains { $0.accessibilityLabel?.hasPrefix("Video,") == true } }
        let tile = try XCTUnwrap(grid.visibleCells.compactMap { $0 as? AttachGridCell }.first { $0.itemID == asset.localIdentifier })
        XCTAssertTrue(tile.accessibilityLabel?.hasPrefix("Video,") == true)
        tile.check.sendActions(for: .touchUpInside)
        XCTAssertTrue(tile.accessibilityLabel?.contains("picked 1") == true)
        try await keep(window, "composer-plus-video-grid")
        try await Task.sleep(for: .milliseconds(500))
        // Sent from the menu: the composer sends it, and the chat shows it.
        try button("attach-send", in: sheet.view).sendActions(for: .touchUpInside)
        try await wait { chat.presentedViewController == nil && card.configuration.attachments.isEmpty }
        try await wait { self.videoTiles(chat.view) == 1 }
        try await keep(window, "composer-video-sent")

        // The same + again: the video is still first, and sends again.
        try plus(in: card).sendActions(for: .touchUpInside)
        try await wait { chat.presentedViewController is AttachSheetViewController }
        let secondSheet = try XCTUnwrap(chat.presentedViewController as? AttachSheetViewController)
        let secondGrid = try XCTUnwrap(subviews(secondSheet.view).first { $0.accessibilityIdentifier == "attach-grid" } as? UICollectionView)
        try await wait { secondGrid.visibleCells.compactMap { $0 as? AttachGridCell }.contains { $0.itemID == asset.localIdentifier } }
        let cell = try XCTUnwrap(secondGrid.visibleCells.compactMap { $0 as? AttachGridCell }.first { $0.itemID == asset.localIdentifier })
        cell.check.sendActions(for: .touchUpInside)
        try await keep(window, "composer-grid-video-picked")
        try await Task.sleep(for: .milliseconds(500))
        try button("attach-send", in: secondSheet.view).sendActions(for: .touchUpInside)
        try await wait { chat.presentedViewController == nil }
        try await wait { self.videoTiles(chat.view) == 2 }
    }

    private func videoTiles(_ view: UIView) -> Int {
        subviews(view).filter { ($0 as? ChatMediaView)?.window != nil && !$0.isHidden }.count
    }

    private func assertVideo(_ card: AgentInputCardView, source: URL) throws {
        let attachment = try XCTUnwrap(card.configuration.attachments.first)
        XCTAssertEqual(attachment.mimeType, "video/quicktime")
        XCTAssertEqual(try Data(contentsOf: attachment.fileURL), try Data(contentsOf: source))
        let preview = try XCTUnwrap(subviews(card).compactMap { $0 as? AttachmentThumbnailView }.first)
        let image = try XCTUnwrap(preview.subviews.compactMap { $0 as? UIImageView }.first?.image?.cgImage)
        var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
        try pixels.withUnsafeMutableBytes { bytes in
            let context = try XCTUnwrap(CGContext(data: bytes.baseAddress, width: image.width, height: image.height,
                bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        XCTAssertTrue(stride(from: 3, to: pixels.count, by: 4).contains { pixels[$0] > 0 },
            "The video preview icon must draw visible pixels, not an empty missing-glyph image")
    }

    private func plus(in card: AgentInputCardView) throws -> UIControl {
        try XCTUnwrap(subviews(card).compactMap { $0 as? UIControl }.first { $0.accessibilityLabel == "Add a picture" })
    }

    private func button(_ id: String, in view: UIView) throws -> UIControl {
        try XCTUnwrap(subviews(view).compactMap { $0 as? UIControl }.first { $0.accessibilityIdentifier == id })
    }

    private func subviews(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(subviews) }

    private func wait(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(15)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(25)) }
        XCTAssertTrue(condition(), "The attachment UI never reached the expected state")
    }

    private func keep(_ window: UIWindow, _ name: String) async throws {
        try await wait { window.rootViewController?.presentedViewController?.transitionCoordinator == nil }
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func makeVideo(at url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 32, AVVideoHeightKey: 32])
        let buffers = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input,
            sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 32, kCVPixelBufferHeightKey as String: 32])
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        var buffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 32, 32, kCVPixelFormatType_32BGRA, nil, &buffer), kCVReturnSuccess)
        let pixels = try XCTUnwrap(buffer)
        CVPixelBufferLockBaseAddress(pixels, [])
        memset(CVPixelBufferGetBaseAddress(pixels), 200, CVPixelBufferGetDataSize(pixels))
        CVPixelBufferUnlockBaseAddress(pixels, [])
        try await wait { input.isReadyForMoreMediaData }
        XCTAssertTrue(buffers.append(pixels, withPresentationTime: .zero))
        writer.endSession(atSourceTime: CMTime(value: 1, timescale: 1))
        input.markAsFinished()
        await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed, "\(String(describing: writer.error))")
    }
}
#endif