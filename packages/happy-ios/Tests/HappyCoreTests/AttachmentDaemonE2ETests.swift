#if canImport(ImageIO)
import Foundation
import ImageIO
import Security
import UniformTypeIdentifiers
import XCTest
import HappyWire
@testable import HappyCore

/// What went over the wire, as URLSession measured it: headers and bodies
/// both ways, bodies as sent (compressed where the daemon compressed them).
private final class Wire: NSObject, URLSessionTaskDelegate, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var counted = (up: 0, down: 0)
    func total() -> (up: Int, down: Int) { lock.withLock { counted } }
    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        lock.withLock {
            for one in metrics.transactionMetrics {
                counted.up += Int(one.countOfRequestHeaderBytesSent + one.countOfRequestBodyBytesSent)
                counted.down += Int(one.countOfResponseHeaderBytesReceived + one.countOfResponseBodyBytesReceived)
            }
        }
    }
}

/// The daemon's API over plain HTTP on loopback, each request measured.
/// `lose` loses the answer to the nth chunk carrying bytes after it
/// arrived, as a dropped connection does; `suspend` stops the upload there.
private final class LoopbackTransport: AgentTransport, @unchecked Sendable {
    let base: String
    let wire = Wire()
    private let lock = NSLock()
    private var chunks = 0
    private var fault: (at: Int, suspend: Bool)?
    private(set) var log: [String] = []

    init(base: String) { self.base = base }

    func fail(at chunk: Int, suspend: Bool) { lock.withLock { chunks = 0; fault = (chunk, suspend); log = [] } }
    func requests() -> [String] { lock.withLock { log } }

    func browserConnection() async throws -> any BrowserStream { throw URLError(.unsupportedURL) }
    func close() async {}

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        var request = URLRequest(url: URL(string: base + path)!)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        if body != nil, !headers.keys.contains(where: { $0.lowercased() == "content-type" }) { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await URLSession.shared.data(for: request, delegate: wire)
        let http = response as! HTTPURLResponse
        let range = headers["Content-Range"]
        let failing = lock.withLock { () -> Bool? in
            log.append("\(method) \(path.split(separator: "?")[0].suffix(12)) \(range ?? "") → \(http.statusCode)")
            guard let range, !range.hasPrefix("bytes */"), let fault else { return nil }
            chunks += 1
            guard chunks == fault.at else { return nil }
            self.fault = nil
            return fault.suspend
        }
        if let failing { throw failing ? CancellationError() as Error : URLError(.networkConnectionLost) }
        let fields = Dictionary(http.allHeaderFields.map { ("\($0.key)".lowercased(), "\($0.value)") }, uniquingKeysWith: { first, _ in first })
        return HTTP1Response(status: http.statusCode, headers: fields, body: data)
    }
}

/// The agent's event stream, kept while a send goes: every byte, and the
/// `message.created` events whole.
private final class EventTap: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var text = ""
    private var task: URLSessionDataTask?
    private var session: URLSession!
    private var wireBytes = 0

    func start(base: String, token: String) {
        session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        var request = URLRequest(url: URL(string: base + "/v0/events/stream")!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        task = session.dataTask(with: request)
        task?.resume()
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.withLock { text += String(decoding: data, as: UTF8.self) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        lock.withLock { wireBytes = metrics.transactionMetrics.reduce(0) { $0 + Int($1.countOfResponseBodyBytesReceived) } }
    }
    /// The `data:` of the `message.created` for `id`, once it came.
    func created(_ id: String) -> String? {
        lock.withLock {
            text.components(separatedBy: "\n\n").first { $0.contains("event: message.created\n") && $0.contains("\"id\":\"\(id)\"") }
                .flatMap { $0.components(separatedBy: "\n").first { $0.hasPrefix("data: ") } }
                .map { String($0.dropFirst("data: ".count)) }
        }
    }
    func stop() async -> (decoded: Int, wire: Int) {
        task?.cancel()
        try? await Task.sleep(for: .milliseconds(300))
        session.invalidateAndCancel()
        return lock.withLock { (text.utf8.count, wireBytes) }
    }
}

/// Against a real daemon (happy-agent 2026.11.6-preview.4 or later),
/// listening on loopback: `HAPPY_E2E_URL`, `HAPPY_E2E_TOKEN`, and
/// `HAPPY_E2E_AGENT`, an idle agent that takes messages. Skipped without them.
final class AttachmentDaemonE2ETests: XCTestCase {
    private var environment: (url: String, token: String, agent: String)?

    override func setUpWithError() throws {
        let values = ProcessInfo.processInfo.environment
        guard let url = values["HAPPY_E2E_URL"], let token = values["HAPPY_E2E_TOKEN"], let agent = values["HAPPY_E2E_AGENT"] else {
            throw XCTSkip("Set HAPPY_E2E_URL, HAPPY_E2E_TOKEN and HAPPY_E2E_AGENT to run against a daemon.")
        }
        environment = (url, token, agent)
    }

    /// A PNG of noise, so neither PNG nor the wire compresses it: about `bytes` long.
    private func picture(bytes: Int, seed: UInt8) throws -> Data {
        let side = Int((Double(bytes) / 3).squareRoot())
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        var state = UInt64(seed) &+ 0x9E37_79B9_7F4A_7C15
        for index in pixels.indices {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            pixels[index] = index % 4 == 3 ? 255 : UInt8(truncatingIfNeeded: state >> 33)
        }
        let provider = CGDataProvider(data: Data(pixels) as CFData)!
        let image = CGImage(width: side, height: side, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: side * 4, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
        let out = NSMutableData()
        let destination = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return out as Data
    }

    /// Sends one picture as the app does and measures it: the requests'
    /// bytes both ways, and the `message.created` the agent's stream carried.
    private func measure(_ client: AgentClient, _ transport: LoopbackTransport, picture: Data, id: String, media: MediaStore? = nil) async throws -> (up: Int, down: Int, event: Int, stream: Int) {
        let (url, token, agent) = environment!
        let mode = try await client.modelCatalog().defaultMode()
        let tap = EventTap()
        tap.start(base: url, token: token)
        try await Task.sleep(for: .milliseconds(500))
        try await Task.sleep(for: .milliseconds(200))
        let before = transport.wire.total()
        let message = QueuedMessage(id: id, agentID: agent, text: "", pictures: [.init(mimeType: "image/png", data: picture)], mode: mode)
        try await client.deliverMessage(message, board: UploadProgressBoard(), media: media) { _ in }
        var event: String?
        for _ in 0..<100 where event == nil {
            try await Task.sleep(for: .milliseconds(100))
            event = tap.created(id)
        }
        let stream = await tap.stop()
        let after = transport.wire.total()
        let created = try XCTUnwrap(event, "no message.created for \(id)")
        return (after.up - before.up, after.down - before.down, created.utf8.count, stream.wire)
    }

    func testTwoMegabytePictureBeforeAndAfter() async throws {
        let (url, token, agent) = environment!
        let stamp = String(Int(Date().timeIntervalSince1970), radix: 36)

        // Before: a computer without attachments gets the picture inline.
        let inlineTransport = LoopbackTransport(base: url)
        let inline = AgentClient(transport: inlineTransport, token: token)
        inline.attachmentSupport.missing()
        let first = try picture(bytes: 2_000_000, seed: 1)
        let old = try await measure(inline, inlineTransport, picture: first, id: "inline\(stamp)")

        // After: uploaded once, named by the send.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let media = MediaStore(directory: root)
        let transport = LoopbackTransport(base: url)
        let client = AgentClient(transport: transport, token: token)
        let second = try picture(bytes: 2_000_000, seed: 2)
        let new = try await measure(client, transport, picture: second, id: "attached\(stamp)", media: media)

        let report = """
        2 MB picture (\(first.count) and \(second.count) bytes), wire bytes incl. headers:
          inline:      up \(old.up), down \(old.down), message.created \(old.event) (stream body on wire \(old.stream)), total \(old.up + old.down + old.stream)
          attachments: up \(new.up), down \(new.down), message.created \(new.event) (stream body on wire \(new.stream)), total \(new.up + new.down + new.stream)
        """
        print(report)
        try report.write(toFile: (ProcessInfo.processInfo.environment["HAPPY_E2E_REPORT"] ?? NSTemporaryDirectory() + "attachments-e2e.txt"), atomically: true, encoding: .utf8)
        XCTAssertLessThan(new.down + new.stream, 100_000)
        XCTAssertLessThan(new.up, second.count + 50_000)

        // The message names the attachment, measured by the daemon.
        let id = Attachments.id(second)
        let history = try await client.send("GET", "/v0/agents/\(agent)/messages?limit=5").body
        let text = String(decoding: history, as: UTF8.self)
        XCTAssertTrue(text.contains(id))
        XCTAssertTrue(text.contains("\"kind\":\"image\""))
        // The sender keeps its own copy: nothing to read back.
        XCTAssertEqual(media.read(Media.attachmentResource(agentId: agent, id: id), 0..<second.count, seal: nil), second)
        // A range of it, and a cached copy that is still good.
        let part = try await client.attachment(agent, id: id, range: 0...99)
        XCTAssertEqual(part.status, 206)
        XCTAssertEqual(part.body, second.prefix(100))
        let etag = try XCTUnwrap(part.headers["etag"])
        let unchanged = try await client.send("GET", "/v0/agents/\(agent)/attachments/\(id)", headers: ["If-None-Match": etag], category: .file)
        XCTAssertEqual(unchanged.status, 304)
        // Gone is a 404.
        do {
            _ = try await client.attachment(agent, id: String(repeating: "0", count: 64))
            XCTFail("Expected 404")
        } catch AgentClientError.status(404, _, _) {}
    }

    func testLargeFileResumesAfterADropAndASuspension() async throws {
        let (url, token, agent) = environment!
        let transport = LoopbackTransport(base: url)
        let client = AgentClient(transport: transport, token: token)
        var bytes = Data(count: 20 * 1024 * 1024)
        bytes.withUnsafeMutableBytes { _ = SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!) }
        let id = Attachments.id(bytes)

        // Suspended after the first chunk: what arrived stays.
        transport.fail(at: 1, suspend: true)
        do {
            try await client.attach(agent, id: id, bytes: bytes, name: "big.bin", mimeType: "application/octet-stream", retryDelay: .milliseconds(100))
            XCTFail("Expected the suspension")
        } catch is CancellationError {}
        let suspended = transport.requests()
        // Resumed, with the answer to its second chunk lost on the way.
        transport.fail(at: 2, suspend: false)
        try await client.attach(agent, id: id, bytes: bytes, name: "big.bin", mimeType: "application/octet-stream", retryDelay: .milliseconds(100))
        let resumed = transport.requests()
        print("suspended:\n  " + suspended.joined(separator: "\n  ") + "\nresumed:\n  " + resumed.joined(separator: "\n  "))
        XCTAssertEqual(resumed.first?.contains("bytes */20971520 → 200"), true)
        XCTAssertFalse(resumed.contains { $0.contains("bytes 0-8388607/") }, "the first chunk went again")
        XCTAssertEqual(resumed.last?.hasSuffix("→ 201"), true)
        let back = try await client.attachment(agent, id: id)
        XCTAssertEqual(back.body, bytes)
        // Unsent, it may be cancelled; sending it again starts nothing new.
        _ = try await client.send("DELETE", "/v0/agents/\(agent)/attachments/\(id)")
    }
}
#endif
