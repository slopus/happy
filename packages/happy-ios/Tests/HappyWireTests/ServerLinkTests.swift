import XCTest
@testable import HappyWire

/// Happy Desktop's server code, to the edge SSO contract v5 §8 grammar.
final class ServerLinkTests: XCTestCase {
    private let instance = "k3x9q2m7p0a4b8c1d5e6f7g2"

    func testTheContractsExampleParsesAndFormats() throws {
        let text = "happy://\(instance)/server?url=https%3A%2F%2Fhappy.acme.example%2F"
        let link = try XCTUnwrap(ServerLink(text))
        XCTAssertEqual(link.instanceId, instance)
        XCTAssertEqual(link.base, "https://happy.acme.example/")
        XCTAssertEqual(link.origin.value, "https://happy.acme.example")
        XCTAssertEqual(link.path, "/")
        XCTAssertEqual(link.url, text)
        XCTAssertEqual(HappyCode(text), .server(link))
    }

    func testAnyValidEscapeAPortAndAPathPrefixAreWellFormed() throws {
        let lower = try XCTUnwrap(ServerLink("happy://\(instance)/server?url=https%3a%2f%2fhappy.acme.example%3a8443%2f"))
        XCTAssertEqual(lower.origin.value, "https://happy.acme.example:8443")
        XCTAssertEqual(lower.url, "happy://\(instance)/server?url=https%3A%2F%2Fhappy.acme.example%3A8443%2F")
        // Unescaped characters a URL query allows decode as themselves.
        XCTAssertEqual(ServerLink("happy://\(instance)/server?url=https://happy.acme.example/")?.base, "https://happy.acme.example/")
        let prefixed = try XCTUnwrap(ServerLink("happy://\(instance)/server?url=https%3A%2F%2Facme.example%2Fteams%2Fhappy%2F"))
        XCTAssertEqual(prefixed.path, "/teams/happy/")
        XCTAssertEqual(prefixed.origin.value, "https://acme.example")
        XCTAssertEqual(ServerLink("happy://\(instance)/server?url=https%3A%2F%2F%5B2001%3Adb8%3A%3A1%5D%2F")?.origin.host, "2001:db8::1")
    }

    /// Any violation is malformed, and never repaired.
    func testEverythingElseIsMalformed() {
        let base = "happy://\(instance)/server?url="
        let origin = "https%3A%2F%2Fhappy.acme.example"
        for text in [
            // The decoded URL isn't a normalized https base URL.
            base + "http%3A%2F%2Fhappy.acme.example%2F", base + origin, base + "HTTPS%3A%2F%2Fhappy.acme.example%2F",
            base + "https%3A%2F%2FHappy.Acme.Example%2F", base + "https%3A%2F%2Fhappy.acme.example%3A443%2F",
            base + "https%3A%2F%2Fu%40happy.acme.example%2F", base + origin + "%2F%3Fx%3D1", base + origin + "%2F%23top",
            base + origin + "%2Fteams", base + origin + "%2Fa%2F..%2F", base + origin + "%2F.%2F", base + origin + "%2F%252e%2F",
            base + origin + "%2Fa%20b%2F", base + origin + "%2F%5C%2F", base + "https%3A%2F%2F127.1%2F", base + "https%3A%2F%2Fh%C3%A9.example%2F",
            // Broken escapes and bytes that aren't UTF-8.
            base + origin + "%2", base + origin + "%2G", base + origin + "%2F%FF%2F",
            // Anything beside the one url parameter.
            base + origin + "%2F&x=1", base + origin + "%2F#x", "happy://\(instance)/server?x=1&url=" + origin + "%2F",
            "happy://\(instance)/server/?url=" + origin + "%2F", "happy://\(instance)/server?url=", "happy://\(instance)/server",
            "happy://\(instance)/server?URL=" + origin + "%2F",
            // The installation.
            "happy://K3x9q2m7p0a4b8c1d5e6f7g2/server?url=" + origin + "%2F", "happy://3x9q2m7p0a4b8c1d5e6f7g2a/server?url=" + origin + "%2F",
            "happy://\(instance):1/server?url=" + origin + "%2F", "happy://u@\(instance)/server?url=" + origin + "%2F",
            base + origin + "%2F" + String(repeating: "a", count: 4096),
        ] {
            XCTAssertNil(ServerLink(text), text)
        }
    }

    /// A server code that's broken is still a server code, told apart from
    /// everything else; it is never a Happy link.
    func testItIsTellableAndNotAHappyLink() {
        XCTAssertTrue(ServerLink.isServerLink("happy://\(instance)/server?url=nope"))
        XCTAssertTrue(ServerLink.isServerLink("happy://\(instance)/server"))
        XCTAssertTrue(ServerLink.isServerLink("happy://\(instance)/server/x"))
        XCTAssertEqual(HappyCode("happy://\(instance)/server?url=nope"), .invalid(.server))
        XCTAssertFalse(ServerLink.isServerLink("happy://\(instance)/servers"))
        XCTAssertFalse(ServerLink.isServerLink("happy://\(instance)/artifacts/q3report"))
        XCTAssertFalse(ServerLink.isServerLink("happy://artifacts/server"))
        XCTAssertNil(HappyLink("happy://\(instance)/server?url=https%3A%2F%2Fhappy.acme.example%2F"))
    }
}
