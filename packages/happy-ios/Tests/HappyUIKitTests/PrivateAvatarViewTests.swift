#if canImport(UIKit)
import HappyCore
import HappyCrypto
import HappyWire
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

private actor HeldAvatarHTTP: HTTPTransport {
    var bodies: [String: Data] = [:]
    var pending: [String: CheckedContinuation<HTTPResponse, Never>] = [:]
    var started: Set<String> = []
    var entrants: [String: [CheckedContinuation<Void, Never>]] = [:]

    func set(_ id: String, body: Data) { bodies[id] = body }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let parts = request.url.path.split(separator: "/")
        if request.method == "POST", parts.count > 2 {
            let id = String(parts[2])
            return HTTPResponse(status: 200, body: Data("{\"ref\":\"\(id)\",\"downloadUrl\":\"https://server.test/\(id)\"}".utf8))
        }
        let id = String(parts.last ?? "")
        return await withCheckedContinuation { continuation in
            pending[id] = continuation
            started.insert(id)
            for waiter in entrants.removeValue(forKey: id) ?? [] { waiter.resume() }
        }
    }

    func untilStarted(_ id: String) async {
        if started.contains(id) { return }
        await withCheckedContinuation { entrants[id, default: []].append($0) }
    }

    func finish(_ id: String) {
        pending.removeValue(forKey: id)?.resume(returning: HTTPResponse(status: 200, body: bodies[id] ?? Data()))
    }
}

@MainActor
final class PrivateAvatarViewTests: XCTestCase {
    private func png(_ color: UIColor) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: 60, height: 30), format: format).pngData { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 60, height: 30))
        }
    }

    func testReuseRejectsOldCompletionAndKeepsCropShapeAndBadge() async throws {
        let keys = try AccountKeys(secret: Data(repeating: 1, count: 32))
        let key = Data(repeating: 2, count: 32)
        let wrapped = try keys.wrapDataKey(key).base64EncodedString()
        let preview = try RecordCipher(key: key).encrypt(.object(["thumbhash": .string("hash"), "mimeType": .string("image/png")]))
        func source(_ id: String) -> AvatarImageSource {
            .init(scope: .session, id: id, descriptor: .init(ref: id, preview: preview, version: 1), dataKeyCipher: wrapped)
        }
        let http = HeldAvatarHTTP()
        await http.set("first", body: try BlobCipher.seal(png(.red), key: BlobCipher.sessionKey(dataKey: key)))
        await http.set("second", body: try BlobCipher.seal(png(.blue), key: BlobCipher.sessionKey(dataKey: key)))
        let cache = AvatarPictures(owner: keys.anonID, directory: nil,
            api: HappyAPI(serverURL: URL(string: "https://server.test")!, clientID: "test", transport: http, token: "token"), keys: keys)
        let view = AvatarView(frame: CGRect(x: 0, y: 0, width: 48, height: 48))
        view.pictures = cache
        view.content = .init(avatar: SessionAvatar(seed: "first", isBot: true, harness: .rig, image: source("first")), style: .brutalist, monochrome: false)
        let firstTask = view.imageTask
        await http.untilStarted("first")
        XCTAssertTrue(view.photo.isHidden, "bot fallback stays while loading")
        view.content = .init(avatar: SessionAvatar(seed: "second", harness: .codex, image: source("second")), style: .brutalist, monochrome: true, square: true)
        let secondTask = view.imageTask
        await http.untilStarted("second")
        await http.finish("second")
        await secondTask?.value
        let secondImage = try XCTUnwrap(view.photo.image)
        XCTAssertFalse(view.photo.isHidden)
        XCTAssertFalse(view.badge.isHidden)
        XCTAssertEqual(view.photo.contentMode, .scaleAspectFill)
        view.layoutIfNeeded()
        XCTAssertEqual(view.disc.layer.cornerRadius, 0)
        XCTAssertEqual(view.photo.frame, view.disc.bounds)
        XCTAssertEqual(secondImage.cgImage?.width, 60)
        XCTAssertEqual(secondImage.cgImage?.height, 30)
        await http.finish("first")
        await firstTask?.value
        XCTAssertTrue(view.photo.image === secondImage, "a cancelled reused view cannot show the old image")
        view.content = .init(avatar: SessionAvatar(seed: "fallback", isBot: true), style: .pixelated, monochrome: false)
        view.layoutIfNeeded()
        XCTAssertNil(view.photo.image)
        XCTAssertTrue(view.photo.isHidden)
        XCTAssertTrue(view.badge.isHidden)
        XCTAssertEqual(view.disc.layer.cornerRadius, 24)
        await cache.close()
    }

    func testMissingOrInvalidImageKeepsGeneratedFallback() async throws {
        let keys = try AccountKeys(secret: Data(repeating: 1, count: 32))
        let cache = AvatarPictures(owner: keys.anonID, directory: nil,
            api: HappyAPI(serverURL: URL(string: "https://server.test")!, clientID: "test", transport: HeldAvatarHTTP(), token: "token"), keys: keys)
        let view = AvatarView(frame: CGRect(x: 0, y: 0, width: 48, height: 48))
        view.pictures = cache
        let source = AvatarImageSource(scope: .session, id: "missing", descriptor: .init(ref: "ref", preview: "invalid", version: 1), dataKeyCipher: "invalid")
        view.content = .init(avatar: SessionAvatar(seed: "identity", harness: .claude, image: source), style: .pixelated, monochrome: false)
        await view.imageTask?.value
        XCTAssertTrue(view.photo.isHidden)
        XCTAssertFalse(view.pixels.isHidden)
        XCTAssertEqual(view.pixels.colors.count, 64)
        XCTAssertFalse(view.badge.isHidden)
        view.content = nil
        XCTAssertTrue(view.photo.isHidden)
        XCTAssertTrue(view.badge.isHidden)
        await cache.close()
    }
}
#endif
