#if canImport(Network)
import Foundation
import Network
import Security
import XCTest
import HappyWire
@testable import HappyCore

final class HTTPSConnectionTests: XCTestCase {
    /// A local fake peer observes TLS, never an HTTP bearer. An intentionally
    /// invalid Tailcat address proves that selecting HTTPS never opens Tailcat.
    func testPublicEndpointStartsTLSAndDoesNotFallBackAfterFailure() async throws {
        let listener = try NWListener(using: .tcp, on: .any)
        let ready = expectation(description: "fake peer listening")
        let hello = expectation(description: "TLS ClientHello received")
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.fulfill() }
        }
        listener.newConnectionHandler = { connection in
            connection.start(queue: DispatchQueue(label: "happy.test.https.peer"))
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { bytes, _, _, _ in
                XCTAssertEqual(bytes?.first, 0x16) // TLS handshake record, not GET.
                XCTAssertFalse(String(decoding: bytes ?? Data(), as: UTF8.self).contains("secret-device-token"))
                hello.fulfill()
                connection.cancel() // Fail TLS; the client must not try Tailcat.
            }
        }
        listener.start(queue: DispatchQueue(label: "happy.test.https.listener"))
        defer { listener.cancel() }
        await fulfillment(of: [ready], timeout: 3)
        let port = try XCTUnwrap(listener.port).rawValue
        let transport = AgentHTTPTransport(address: "not-a-valid-tailcat-address", port: 24781, publicUrl: "https://127.0.0.1:\(port)")
        let request = Task { try? await transport.request("/v0/health", credential: "secret-device-token") }
        let started = ContinuousClock.now
        await fulfillment(of: [hello], timeout: 3)
        let result = await request.value
        XCTAssertNil(result)
        XCTAssertLessThan(started.duration(to: .now), .seconds(5))
        await transport.close()
    }

    func testRefusedConnectionFailsRawBrowserWritePromptly() async throws {
        let listener = try NWListener(using: .tcp, on: .any)
        let ready = expectation(description: "port allocated")
        listener.stateUpdateHandler = { if case .ready = $0 { ready.fulfill() } }
        listener.newConnectionHandler = { $0.cancel() }
        listener.start(queue: DispatchQueue(label: "happy.test.refused"))
        await fulfillment(of: [ready], timeout: 3)
        let port = try XCTUnwrap(listener.port).rawValue
        listener.cancel()
        let stream = try HTTPSBrowserStream.open(AgentOrigin("https://127.0.0.1:\(port)"), onClose: {})
        let started = ContinuousClock.now
        do { try await stream.write(Data("CONNECT /v0/proxy HTTP/1.1\r\n\r\n".utf8)); XCTFail("refused connection accepted") }
        catch { }
        XCTAssertLessThan(started.duration(to: .now), .seconds(5))
        await stream.close()
    }

    func testCancellationResolvesConcurrentReadAndWriteDuringHandshake() async throws {
        let listener = try NWListener(using: .tcp, on: .any)
        let ready = expectation(description: "listening")
        listener.stateUpdateHandler = { if case .ready = $0 { ready.fulfill() } }
        listener.newConnectionHandler = { connection in
            connection.start(queue: DispatchQueue(label: "happy.test.stalled.peer"))
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { _, _, _, _ in
                // Keep the peer alive without completing its TLS handshake.
                connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { _, _, _, _ in connection.cancel() }
            }
        }
        listener.start(queue: DispatchQueue(label: "happy.test.stalled"))
        defer { listener.cancel() }
        await fulfillment(of: [ready], timeout: 3)
        let stream = try HTTPSBrowserStream.open(AgentOrigin("https://127.0.0.1:\(try XCTUnwrap(listener.port).rawValue)"), onClose: {})
        let read = Task { try? await stream.read(maximumBytes: 1024) }
        let write = Task { try? await stream.write(Data("secret".utf8)) }
        read.cancel()
        let data = await read.value
        let written: Void? = await write.value
        XCTAssertNil(data); XCTAssertNil(written)
        await stream.close()
    }

    func testStalledTLSHandshakeHasItsOwnDeadlineWithoutCallerCancellation() async throws {
        let listener = try NWListener(using: .tcp, on: .any)
        let ready = expectation(description: "stalled peer listening")
        let hello = expectation(description: "stalled peer got TLS handshake")
        listener.stateUpdateHandler = { if case .ready = $0 { ready.fulfill() } }
        listener.newConnectionHandler = { connection in
            connection.start(queue: DispatchQueue(label: "happy.test.deadline.peer"))
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { _, _, _, _ in
                hello.fulfill()
                connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { _, _, _, _ in connection.cancel() }
            }
        }
        listener.start(queue: DispatchQueue(label: "happy.test.deadline"))
        defer { listener.cancel() }
        await fulfillment(of: [ready], timeout: 3)
        let stream = try HTTPSBrowserStream.open(AgentOrigin("https://127.0.0.1:\(try XCTUnwrap(listener.port).rawValue)"), handshakeTimeout: 0.25, onClose: {})
        let started = ContinuousClock.now
        // SSE's initial header write and browser CONNECT use this same raw
        // stream without the ordinary HTTP request's outer timeout.
        async let read: Data? = try? stream.read(maximumBytes: 1024)
        do { try await stream.write(Data("GET /v0/events/stream HTTP/1.1\r\n\r\n".utf8)); XCTFail("stalled TLS accepted") }
        catch { XCTAssertEqual(error as? PairingError, .unavailable) }
        let received = await read
        XCTAssertNil(received)
        XCTAssertLessThan(started.duration(to: .now), .seconds(2))
        await fulfillment(of: [hello], timeout: 1)
        await stream.close()
    }

    #if os(macOS)
    func testUntrustedAndWrongHostnameCertificatesFailBeforeWritingBearer() async throws {
        // An ephemeral TLS fixture, with no keychain or system trust changes.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let configuration = directory.appendingPathComponent("openssl.cnf")
        try """
        [req]
        distinguished_name=dn
        x509_extensions=extensions
        prompt=no
        [dn]
        CN=localhost
        [extensions]
        subjectAltName=DNS:localhost
        basicConstraints=critical,CA:TRUE
        keyUsage=digitalSignature,keyEncipherment,keyCertSign
        extendedKeyUsage=serverAuth
        """.write(to: configuration, atomically: true, encoding: .utf8)
        let certificate = directory.appendingPathComponent("cert.pem")
        let key = directory.appendingPathComponent("key.pem")
        func openssl(_ arguments: [String]) throws {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
            process.arguments = arguments
            process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
            try process.run(); process.waitUntilExit()
            XCTAssertEqual(process.terminationStatus, 0)
        }
        try openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", configuration.path, "-keyout", key.path, "-out", certificate.path])
        let der = directory.appendingPathComponent("cert.der")
        try openssl(["x509", "-in", certificate.path, "-outform", "der", "-out", der.path])
        let anchor = try XCTUnwrap(SecCertificateCreateWithData(nil, Data(contentsOf: der) as CFData))
        let listener = try NWListener(using: .tcp, on: .any)
        let allocated = expectation(description: "allocated TLS port")
        let released = expectation(description: "released TLS port")
        listener.newConnectionHandler = { $0.cancel() }
        listener.stateUpdateHandler = { state in
            if case .ready = state { allocated.fulfill() }
            if case .cancelled = state { released.fulfill() }
        }
        listener.start(queue: DispatchQueue(label: "happy.test.tls.port"))
        await fulfillment(of: [allocated], timeout: 3)
        let port = try XCTUnwrap(listener.port).rawValue
        listener.cancel()
        await fulfillment(of: [released], timeout: 3)
        let peer = Process(), output = Pipe()
        let exited = expectation(description: "TLS fixture exited")
        peer.terminationHandler = { _ in exited.fulfill() }
        peer.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
        peer.arguments = ["s_server", "-accept", String(port), "-cert", certificate.path, "-key", key.path, "-www"]
        peer.standardOutput = output; peer.standardError = output
        try peer.run()
        // Async tests can resume on a different thread/run loop; a blocking
        // waitUntilExit after an await can miss Process's exit notification.
        defer { if peer.isRunning { peer.terminate() } }
        var text = ""
        while !text.contains("ACCEPT") {
            let bytes = output.fileHandleForReading.availableData
            guard !bytes.isEmpty else { return XCTFail("TLS fixture failed to start: \(text)") }
            text += String(decoding: bytes, as: UTF8.self)
        }

        let untrusted = try HTTPSBrowserStream.open(AgentOrigin("https://localhost:\(port)"), onClose: {})
        let started = ContinuousClock.now
        do { try await untrusted.write(Data("secret-device-token".utf8)); XCTFail("untrusted certificate accepted") }
        catch { }
        XCTAssertLessThan(started.duration(to: .now), .seconds(5))
        await untrusted.close()

        // The wrapper's internal initializer lets this fixture trust only its
        // ephemeral root. Keep Network.framework's original hostname policy.
        func anchored(_ host: String) -> HTTPSBrowserStream {
            let tls = NWProtocolTLS.Options()
            sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
                let trust = sec_trust_copy_ref(trust).takeRetainedValue()
                SecTrustSetAnchorCertificates(trust, [anchor] as CFArray)
                SecTrustSetAnchorCertificatesOnly(trust, true)
                complete(SecTrustEvaluateWithError(trust, nil))
            }, DispatchQueue(label: "happy.test.tls.trust"))
            let connection = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: NWParameters(tls: tls, tcp: NWProtocolTCP.Options()))
            let stream = HTTPSBrowserStream(connection: connection, authority: "\(host):\(port)", onClose: {})
            connection.start(queue: DispatchQueue(label: "happy.test.tls.connection"))
            return stream
        }
        let wrongHost = anchored("127.0.0.1")
        let wrongStarted = ContinuousClock.now
        do { try await wrongHost.write(Data("secret-device-token".utf8)); XCTFail("wrong certificate hostname accepted") }
        catch { }
        XCTAssertLessThan(wrongStarted.duration(to: .now), .seconds(5))
        await wrongHost.close()

        let matchingHost = anchored("localhost")
        try await matchingHost.write(Data("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".utf8))
        let response = try await matchingHost.read(maximumBytes: 8192)
        XCTAssertTrue(String(decoding: response, as: UTF8.self).hasPrefix("HTTP/1.0 200"))
        await matchingHost.close()
        peer.terminate()
        await fulfillment(of: [exited], timeout: 3)
    }
    #endif
}
#endif