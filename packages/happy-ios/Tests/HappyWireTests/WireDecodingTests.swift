import Foundation
import XCTest
@testable import HappyWire

final class WireDecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func testJSONValueRoundTripKeepsIntegersExact() throws {
        let value = try JSONValue.decode(Data(#"{"a":1739347230000,"b":1.5,"c":[true,null,"x"],"d":{}}"#.utf8))
        XCTAssertEqual(value["a"], .number(1_739_347_230_000))
        XCTAssertEqual(try value.encodedString(), #"{"a":1739347230000,"b":1.5,"c":[true,null,"x"],"d":{}}"#)
        XCTAssertEqual(try JSONValue.decode(value.encoded()), value)
    }

    func testNewMessageUpdate() throws {
        let update = try decode(UpdateContainer.self, """
        {"id":"u1","seq":7,"createdAt":5,"body":{"t":"new-message","sid":"s1","message":{
          "id":"m1","seq":3,"localId":null,"content":{"t":"encrypted","c":"QUJD"},"createdAt":1,"updatedAt":2}}}
        """)
        XCTAssertEqual(update.seq, 7)
        guard case .newMessage(let sessionId, let message) = update.body else { return XCTFail("\(update.body)") }
        XCTAssertEqual(sessionId, "s1")
        XCTAssertEqual(message.seq, 3)
        XCTAssertNil(message.localId)
        XCTAssertEqual(message.content.c, "QUJD")
    }

    func testUpdateSessionDistinguishesNullProjectFromMissing() throws {
        let unlinked = try decode(UpdateContainer.self, #"{"id":"u","seq":1,"createdAt":0,"body":{"t":"update-session","id":"s","projectId":null,"metadata":{"version":3,"value":"x"}}}"#)
        guard case .updateSession(let a) = unlinked.body else { return XCTFail() }
        XCTAssertEqual(a.projectId, .some(nil))
        XCTAssertEqual(a.metadata, VersionedValue(version: 3, value: "x"))
        XCTAssertNil(a.agentState)

        let untouched = try decode(UpdateContainer.self, #"{"id":"u","seq":1,"createdAt":0,"body":{"t":"update-session","id":"s","agentState":{"version":2,"value":null}}}"#)
        guard case .updateSession(let b) = untouched.body else { return XCTFail() }
        XCTAssertTrue(b.projectId == nil, "absent, not null")
        XCTAssertEqual(b.agentState, VersionedValue(version: 2, value: nil))
    }

    func testSessionAndMachineLifecycleUpdates() throws {
        let deleted = try decode(UpdateContainer.self, #"{"id":"u","seq":1,"createdAt":0,"body":{"t":"delete-session","sid":"s9"}}"#)
        guard case .deleteSession("s9") = deleted.body else { return XCTFail("\(deleted.body)") }

        let created = try decode(UpdateContainer.self, """
        {"id":"u","seq":1,"createdAt":0,"body":{"t":"new-session","id":"s1","seq":0,"metadata":"m","metadataVersion":1,
         "agentState":null,"agentStateVersion":0,"dataEncryptionKey":"k","projectId":null,"active":true,"activeAt":5,
         "createdAt":4,"updatedAt":5,"avatar":null,"avatarVersion":0}}
        """)
        guard case .newSession(let session) = created.body else { return XCTFail() }
        XCTAssertEqual(session.asSession?.dataEncryptionKey, "k")
        XCTAssertEqual(session.asSession?.activeAt, 5)

        let machine = try decode(UpdateContainer.self, """
        {"id":"u","seq":1,"createdAt":0,"body":{"t":"new-machine","machineId":"m1","seq":2,"metadata":"x","metadataVersion":1,
         "daemonState":null,"daemonStateVersion":0,"dataEncryptionKey":null,"active":false,"activeAt":1,"createdAt":1,"updatedAt":1}}
        """)
        guard case .newMachine(let newMachine) = machine.body else { return XCTFail() }
        XCTAssertEqual(newMachine.asMachine.id, "m1")

        let other = try decode(UpdateContainer.self, #"{"id":"u","seq":1,"createdAt":0,"body":{"t":"new-artifact","artifactId":"a"}}"#)
        guard case .unsupported("new-artifact") = other.body else { return XCTFail("\(other.body)") }
    }

    func testEphemeralEvents() throws {
        XCTAssertEqual(
            try decode(EphemeralEvent.self, #"{"type":"activity","id":"s","active":true,"activeAt":9,"thinking":true}"#),
            .activity(sessionId: "s", active: true, activeAt: 9, thinking: true)
        )
        XCTAssertEqual(
            try decode(EphemeralEvent.self, #"{"type":"machine-activity","id":"m","active":false,"activeAt":3}"#),
            .machineActivity(machineId: "m", active: false, activeAt: 3)
        )
        XCTAssertEqual(try decode(EphemeralEvent.self, #"{"type":"usage","id":"s"}"#), .unsupported(type: "usage"))
    }

    func testSessionProtocolEnvelope() throws {
        let value = try JSONValue.decode(Data("""
        {"role":"session","content":{"id":"e1","time":1739347230000,"role":"agent","turn":"t1",
         "ev":{"t":"tool-call-start","call":"c1","name":"Bash","title":"Run","description":"ls","args":{"cmd":"ls"}}},
         "meta":{"sentFrom":"cli"}}
        """.utf8))
        guard case .session(let envelope, let meta) = MessageContent(decrypted: value) else { return XCTFail() }
        XCTAssertEqual(envelope.role, .agent)
        XCTAssertEqual(envelope.turn, "t1")
        XCTAssertEqual(meta?.sentFrom, "cli")
        XCTAssertTrue(envelope.ev.isToolEvent)
        XCTAssertEqual(envelope.ev, .toolCallStart(call: "c1", name: "Bash", title: "Run", description: "ls", args: ["cmd": .string("ls")]))
    }

    func testUnknownSessionEventsSurviveRoundTrip() throws {
        let raw = #"{"t":"future-thing","x":1}"#
        let event = try decode(SessionEvent.self, raw)
        guard case .unknown("future-thing", _) = event else { return XCTFail("\(event)") }
        let reencoded = try JSONValue.decode(JSONEncoder().encode(event))
        XCTAssertEqual(reencoded, .object(["t": .string("future-thing"), "x": .number(1)]))
    }

    func testLegacyPayloadsAreKeptVerbatimNotParsed() throws {
        let value = try JSONValue.decode(Data(#"{"role":"user","content":{"type":"text","text":"hi"}}"#.utf8))
        guard case .other(let role, let raw) = MessageContent(decrypted: value) else { return XCTFail() }
        XCTAssertEqual(role, "user")
        XCTAssertEqual(raw, value)
    }

    func testMachineListToleratesMissingDaemonStateVersion() throws {
        let machines = try decode([APIMachine].self, """
        [{"id":"m","metadata":"x","metadataVersion":2,"seq":1,"active":true,"activeAt":3,"createdAt":1,"updatedAt":2}]
        """)
        XCTAssertEqual(machines.first?.daemonStateVersion, 0)
        XCTAssertNil(machines.first?.dataEncryptionKey)
    }

    func testAuthAndSettingsResponses() throws {
        XCTAssertEqual(try decode(AccountAuthState.self, #"{"state":"requested"}"#), .requested)
        XCTAssertEqual(
            try decode(AccountAuthState.self, #"{"state":"authorized","token":"t","response":"r"}"#),
            .authorized(token: "t", response: "r")
        )
        XCTAssertEqual(try decode(TerminalAuthStatus.self, #"{"status":"not_found","supportsV2":false}"#).status, .notFound)
        XCTAssertEqual(try decode(UpdateAccountSettingsResponse.self, #"{"success":true,"version":4}"#), .success(version: 4))
        XCTAssertEqual(
            try decode(UpdateAccountSettingsResponse.self, #"{"success":false,"error":"version-mismatch","currentVersion":5,"currentSettings":null}"#),
            .versionMismatch(currentVersion: 5, currentSettings: nil)
        )
    }
}

final class PairingLinkTests: XCTestCase {
    let key = Data((0..<32).map { UInt8($0 * 7 % 256) })

    func testParsesTerminalAndAccountLinks() throws {
        let terminal = PairingLink.terminal(publicKey: key)
        XCTAssertTrue(terminal.urlString.hasPrefix("happy://terminal?"))
        XCTAssertFalse(terminal.urlString.contains("="))
        XCTAssertEqual(PairingLink(terminal.urlString), terminal)

        let account = PairingLink.account(publicKey: key)
        XCTAssertTrue(account.urlString.hasPrefix("happy:///account?"))
        XCTAssertEqual(PairingLink("  \(account.urlString)\n"), account)
    }

    func testRejectsOtherSchemesAndBadKeys() {
        XCTAssertNil(PairingLink("https://happy.engineering"))
        XCTAssertNil(PairingLink("happy://account?abc"))
        XCTAssertNil(PairingLink("happy://terminal?"))
        XCTAssertNil(PairingLink("happy://terminal?AAAA"), "not 32 bytes")
        XCTAssertNil(PairingLink("happy://terminal?!!!"))
    }
}
