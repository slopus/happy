#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Darwin
import Foundation
@testable import HappyCore
@testable import HappyUI
import HappyWire
import UIKit

/// The whole app over a throwaway Happy Agent daemon on this Mac
/// (`-screen agent -agentSocket PATH -agentToken TOKEN`): a simulator's app
/// reaches the Mac's files, so it speaks HTTP over the daemon's own Unix
/// socket where a phone would go through Tailcat. Everything past the
/// transport is the app as it ships: pairing's account, Stem Cells, Stories.
@MainActor
final class AgentHarness {
    private let coordinator: AppCoordinator

    init(window: UIWindow, socket: String, token: String) {
        // Stories shown N times longer, to film one at a person's pace.
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "-storiesShowScale"), arguments.indices.contains(index + 1), let scale = Double(arguments[index + 1]) {
            StoryViewerViewController.showScale = scale
        }
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/agent-harness",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            directTransport: { _ in UnixSocketDirectTransport(path: socket) },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }
        )
        let context = AppContext(account: controller, variant: .development, version: "agent-harness")
        coordinator = AppCoordinator(window: window, context: context)
        Task { @MainActor [coordinator] in
            _ = try? await controller.direct.add(DirectDeviceCredentials(address: "agent-harness", port: 0, deviceID: "agent-harness", deviceToken: token), name: "Happy Agent")
            coordinator.start()
        }
    }
}

/// HTTP/1.1 over a Unix socket, one connection a request, with the framing
/// the Tailcat transport uses.
struct UnixSocketDirectTransport: DirectTransport {
    let path: String

    func request(method: String, path route: String, credential: String, body: Data?, headers: [String: String]) async throws -> DirectHTTPResponse {
        let socket = try await connect()
        defer { Darwin.close(socket) }
        try write(socket, head(method: method, route: route, credential: credential, accept: "application/json", body: body, headers: headers) + (body ?? Data()))
        var parser = DirectHTTPParser()
        while true {
            let bytes = try await read(socket)
            if let response = try parser.append(bytes, eof: bytes.isEmpty) { return response }
        }
    }

    func stream(path route: String, credential: String, headers: [String: String]) async throws -> DirectHTTPStream {
        let socket = try await connect()
        do {
            try write(socket, head(method: "GET", route: route, credential: credential, accept: "text/event-stream", body: nil, headers: headers))
            var buffer = Data()
            var parsed: (DirectHTTPHead, Data)?
            while parsed == nil {
                let bytes = try await read(socket)
                if bytes.isEmpty { throw DirectPairingError.unavailable }
                buffer.append(bytes)
                parsed = try DirectHTTPHead.parse(buffer)
            }
            let (head, rest) = parsed!
            let chunked = head.headers["transfer-encoding"]?.lowercased() == "chunked"
            let body = AsyncThrowingStream<Data, Error> { continuation in
                let reader = Task.detached {
                    var decoder = DirectBodyDecoder(chunked: chunked)
                    do {
                        var bytes = rest
                        while true {
                            let decoded = try decoder.append(bytes)
                            if !decoded.isEmpty { continuation.yield(decoded) }
                            if decoder.finished { break }
                            try Task.checkCancellation()
                            bytes = try await read(socket)
                            if bytes.isEmpty { break }
                        }
                        continuation.finish()
                    } catch { continuation.finish(throwing: error) }
                }
                continuation.onTermination = { _ in reader.cancel(); Darwin.shutdown(socket, SHUT_RDWR); Darwin.close(socket) }
            }
            return DirectHTTPStream(status: head.status, headers: head.headers, body: body)
        } catch {
            Darwin.close(socket)
            throw error
        }
    }

    func close() async {}

    private func head(method: String, route: String, credential: String, accept: String, body: Data?, headers: [String: String]) -> Data {
        var head = "\(method) \(route) HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer \(credential)\r\nConnection: close\r\nAccept: \(accept)\r\n"
        if method != "GET" { head += "Content-Length: \(body?.count ?? 0)\r\n" }
        if body != nil { head += "Content-Type: application/json\r\n" }
        for (name, value) in headers { head += "\(name): \(value)\r\n" }
        return Data((head + "\r\n").utf8)
    }

    private func connect() async throws -> Int32 {
        let path = path
        return try await Task.detached {
            let socket = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
            guard socket >= 0 else { throw DirectPairingError.unavailable }
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            let bytes = Array(path.utf8CString)
            guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { Darwin.close(socket); throw DirectPairingError.unavailable }
            withUnsafeMutableBytes(of: &address.sun_path) { raw in
                raw.copyBytes(from: bytes.map { UInt8(bitPattern: $0) })
            }
            let result = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(socket, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
            }
            guard result == 0 else { Darwin.close(socket); throw DirectPairingError.unavailable }
            var on: Int32 = 1
            setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            return socket
        }.value
    }

    private func write(_ socket: Int32, _ data: Data) throws {
        try data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let sent = Darwin.write(socket, raw.baseAddress! + offset, raw.count - offset)
                guard sent > 0 else { throw DirectPairingError.unavailable }
                offset += sent
            }
        }
    }

    private func read(_ socket: Int32) async throws -> Data {
        try await Task.detached {
            var buffer = [UInt8](repeating: 0, count: 65536)
            let count = Darwin.read(socket, &buffer, buffer.count)
            guard count >= 0 else { throw DirectPairingError.unavailable }
            return Data(buffer[0..<count])
        }.value
    }
}
#endif
