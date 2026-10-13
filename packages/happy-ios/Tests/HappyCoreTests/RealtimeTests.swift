import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

final class SocketIOProtocolTests: XCTestCase {
    func testEngineIOPackets() {
        XCTAssertEqual(
            EngineIOPacket(text: #"0{"sid":"abc","upgrades":[],"pingInterval":15000,"pingTimeout":45000,"maxPayload":8388608}"#),
            .open(EngineIOHandshake(sid: "abc", pingInterval: 15000, pingTimeout: 45000, maxPayload: 8_388_608))
        )
        XCTAssertEqual(EngineIOPacket(text: "2"), .ping)
        XCTAssertEqual(EngineIOPacket.pong.text, "3")
        XCTAssertEqual(EngineIOPacket(text: "40"), .message("0"))
        XCTAssertNil(EngineIOPacket(text: ""))
        XCTAssertNil(EngineIOPacket(text: "9"))
    }

    func testSocketIOPackets() {
        XCTAssertEqual(SocketIOPacket(text: #"0{"sid":"x"}"#), .connect(.object(["sid": .string("x")])))
        XCTAssertEqual(
            SocketIOPacket(text: #"2["update",{"id":"u","seq":1}]"#),
            .event(name: "update", arguments: [.object(["id": .string("u"), "seq": .number(1)])], ackId: nil)
        )
        XCTAssertEqual(SocketIOPacket(text: #"212["rpc-call",{}]"#), .event(name: "rpc-call", arguments: [.object([:])], ackId: 12))
        XCTAssertEqual(SocketIOPacket(text: #"37[{"ok":true}]"#), .ack(id: 7, arguments: [.object(["ok": .bool(true)])]))
        XCTAssertEqual(SocketIOPacket(text: #"4{"message":"Invalid token"}"#), .connectError(.object(["message": .string("Invalid token")])))
        XCTAssertEqual(SocketIOPacket(text: "1"), .disconnect)
        XCTAssertEqual(SocketIOPacket(text: #"2/,["update",1]"#), .event(name: "update", arguments: [.number(1)], ackId: nil), "explicit default namespace")
        XCTAssertNil(SocketIOPacket(text: #"2/admin,["x"]"#), "other namespaces are ignored")
        XCTAssertNil(SocketIOPacket(text: #"51-["bin",{"_placeholder":true}]"#), "binary packets are not supported")
        XCTAssertNil(SocketIOPacket(text: "2not json"))

        XCTAssertEqual(SocketIOPacket.event(name: "app-state", arguments: [.object(["state": .string("active")])], ackId: 3).text, #"23["app-state",{"state":"active"}]"#)
        XCTAssertEqual(SocketIOPacket.connect(.object(["token": .string("t")])).text, #"0{"token":"t"}"#)
    }

    func testSocketURL() {
        XCTAssertEqual(
            SocketIOURL.make(serverURL: URL(string: "https://api.cluster-fluster.com")!)?.absoluteString,
            "wss://api.cluster-fluster.com/v1/updates/?EIO=4&transport=websocket"
        )
        XCTAssertEqual(
            SocketIOURL.make(serverURL: URL(string: "http://192.168.1.2:3005")!)?.absoluteString,
            "ws://192.168.1.2:3005/v1/updates/?EIO=4&transport=websocket"
        )
        XCTAssertNil(SocketIOURL.make(serverURL: URL(string: "ftp://x")!))
    }
}

final class SocketIOClientTests: XCTestCase {
    func testHandshakeHeartbeatEventsAndAcks() async throws {
        let connector = FakeConnector()
        let client = SocketIOClient(url: URL(string: "wss://x/v1/updates/")!, connector: connector) {
            .object(["token": .string("t"), "clientType": .string("user-scoped")])
        }
        let collected = EventLog()
        let reader = Task {
            for await event in client.events { collected.append(event) }
        }
        defer { reader.cancel() }

        await client.connect()
        await eventually { connector.latest != nil }
        let socket = try XCTUnwrap(connector.latest)
        socket.push(#"0{"sid":"s","upgrades":[],"pingInterval":15000,"pingTimeout":45000}"#)
        await eventually { socket.sent.count == 1 }
        XCTAssertEqual(socket.sent[0], #"40{"clientType":"user-scoped","token":"t"}"#)

        socket.push(#"40{"sid":"ns"}"#)
        await eventually { await client.status == .connected }
        socket.push("2")
        await eventually { socket.sent.contains("3") }

        socket.push(#"42["update",{"id":"u1"}]"#)
        await eventually { collected.values.contains(.event(name: "update", payload: .object(["id": .string("u1")]))) }
        XCTAssertTrue(collected.values.contains(.connected))

        async let reply = client.emitWithAck("rpc-call", .object(["method": .string("m")]))
        await eventually { socket.sent.contains(#"420["rpc-call",{"method":"m"}]"#) }
        socket.push(#"430[{"ok":true}]"#)
        let arguments = try await reply
        XCTAssertEqual(arguments, [.object(["ok": .bool(true)])])

        await client.disconnect()
        let finalStatus = await client.status
        XCTAssertEqual(finalStatus, .disconnected)
        XCTAssertTrue(socket.sent.contains("41"))
    }

    func testReconnectsAfterTheSocketDrops() async throws {
        let connector = FakeConnector()
        let client = SocketIOClient(
            url: URL(string: "wss://x/v1/updates/")!,
            connector: connector,
            backoff: Backoff(initial: .milliseconds(1), maximum: .milliseconds(1))
        ) { .object([:]) }
        await client.connect()
        await eventually { connector.latest != nil }
        await connector.latest!.close()
        await eventually { connector.sockets.count >= 2 }
        await client.disconnect()
    }

    func testConnectErrorIsAFailedAttempt() async throws {
        let connector = FakeConnector()
        let client = SocketIOClient(url: URL(string: "wss://x/")!, connector: connector, backoff: Backoff(initial: .seconds(60), maximum: .seconds(60))) { .object([:]) }
        await client.connect()
        await eventually { connector.latest != nil }
        let socket = connector.latest!
        socket.push(#"0{"sid":"s","upgrades":[],"pingInterval":15000,"pingTimeout":45000}"#)
        socket.push(#"44{"message":"Invalid authentication token"}"#)
        await eventually { await client.status == .error }
        await XCTAssertThrowsAsync(try await client.emit("x", .null)) {
            XCTAssertEqual($0 as? SocketIOError, .notConnected)
        }
        await client.disconnect()
    }
}

final class AccountSessionTests: XCTestCase {
    func testSocketUpdatesReachTheStoreAndReconnectsRunADeltaSync() async throws {
        let fixture = ServerFixture()
        let http = FakeHTTP()
        let connector = FakeConnector()
        http.on("GET /v2/sessions", json: SessionsPage(sessions: [fixture.session("s", updatedAt: 10)], nextCursor: nil, hasNext: false))
        http.onRaw("GET /v3/sessions/s/messages", #"{"messages":[],"hasMore":false}"#)
        http.onRaw("GET /v1/machines", "[]")
        http.onRaw("GET /v1/account/settings", #"{"settings":null,"settingsVersion":0}"#)

        let session = try AccountSession(
            credentials: Credentials(token: "tok", secret: fixture.keys.secret),
            store: try LocalStore.inMemory(),
            dependencies: .init(serverURL: testServer, clientID: "ios/1", transport: http, connector: connector, appState: { "background" })
        )
        await session.start()
        await eventually { (try? session.store.session(id: "s")) != nil }
        // connect() opens the socket from its own task, which can run after
        // the sessions pull has landed.
        await eventually { connector.latest != nil }
        XCTAssertEqual(connector.urls.first?.absoluteString, "wss://api.example.test/v1/updates/?EIO=4&transport=websocket")

        let socket = try XCTUnwrap(connector.latest)
        socket.push(#"0{"sid":"s","upgrades":[],"pingInterval":15000,"pingTimeout":45000}"#)
        await eventually { !socket.sent.isEmpty }
        let auth = try JSONValue.decode(Data(socket.sent[0].dropFirst(2).utf8))
        XCTAssertEqual(auth, .object([
            "token": .string("tok"), "clientType": .string("user-scoped"),
            "happyClient": .string("ios/1"), "appState": .string("background"),
        ]))

        socket.push("40{}")
        await eventually { http.requests("GET /v2/sessions").count >= 2 }

        let renamed = fixture.seal(.object(["title": .string("live")]))
        socket.push(#"42["update",{"id":"u","seq":9,"createdAt":0,"body":{"t":"update-session","id":"s","metadata":{"version":2,"value":"\#(renamed)"}}}]"#)
        await eventually { (try? session.store.session(id: "s"))?.metadata?["title"] == .string("live") }

        await session.stop()
    }
}

final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var _values: [RealtimeEvent] = []
    var values: [RealtimeEvent] { lock.lock(); defer { lock.unlock() }; return _values }
    func append(_ value: RealtimeEvent) { lock.lock(); _values.append(value); lock.unlock() }
}
