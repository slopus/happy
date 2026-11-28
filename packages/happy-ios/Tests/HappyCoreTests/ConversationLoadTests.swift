import Foundation
@testable import HappyCore
import HappyWire
import Tailcat
import XCTest
#if canImport(Network)
import Network
#endif

/// What a conversation's first read needs to land, and how its failure is
/// named when it doesn't.
final class ConversationLoadTests: XCTestCase {
    /// A direct connection's tunnel errors are named by what they are,
    /// not `unknown`: a Tailcat client that never connected in its 20
    /// seconds is a timeout.
    func testATunnelsFailureIsNamed() {
        XCTAssertEqual(Problem(TailcatError.timedOut), .timeout)
        XCTAssertEqual(Problem(TailcatError.noRelay), .unreachable)
        XCTAssertEqual(Problem(TailcatError.closed), .offline)
        XCTAssertEqual(Problem(TailcatError.invalidKey), .unknown)
        XCTAssertEqual(Problem(TransportError.timeout), .timeout)
        XCTAssertEqual(Problem(TransportError.connectionFailed("UDP socket: 1")), .unreachable)
        XCTAssertEqual(Problem(TransportError.closed), .offline)
        XCTAssertEqual(Problem(TransportError.malformedPacket), .unknown)
        XCTAssertEqual(Problem(TailcatTransportError.timedOut), .timeout)
        XCTAssertEqual(Problem(TailcatTransportError.connectionRefused), .unreachable)
        XCTAssertEqual(Problem(TailcatTransportError.connectionReset), .offline)
        XCTAssertEqual(Problem(TailcatTransportError.closed), .offline)
        #if canImport(Network)
        XCTAssertEqual(Problem(NWError.posix(.ETIMEDOUT)), .timeout)
        XCTAssertEqual(Problem(NWError.posix(.ECONNREFUSED)), .unreachable)
        XCTAssertEqual(Problem(NWError.posix(.ECONNRESET)), .offline)
        #endif
    }

    /// Only the agent opens its conversation: a mode, draft, context or
    /// subagent this build can't read is none, and the read lands.
    func testABootstrapsUnreadablePartsAreNone() throws {
        let json = #"""
        {"agent":{"id":"a","workspaceId":"w","status":"idle"},
         "mode":{"providerId":"p","modelId":"m","effort":null,"serviceTier":null,"permissionMode":"auto"},
         "draft":{"value":{"text":7},"updatedAt":"later"},
         "context":{"contextTokens":"many"},
         "subagents":[{"id":"c1","workspaceId":"w","status":"idle"},{"id":"c2","workspaceId":"w","status":"idle","wait":{"startedAt":"now"}}],
         "pending":[],"cursor":"c9"}
        """#
        let bootstrap = try JSONDecoder().decode(AgentWire.Bootstrap.self, from: Data(json.utf8))
        XCTAssertEqual(bootstrap.agent.id, "a")
        XCTAssertNil(bootstrap.mode)
        XCTAssertNil(bootstrap.draft)
        XCTAssertNil(bootstrap.context)
        XCTAssertEqual(bootstrap.subagents?.map(\.id), ["c1"])
        XCTAssertEqual(bootstrap.cursor, "c9")
        XCTAssertEqual(bootstrap.pending, [])

        let readable = #"""
        {"agent":{"id":"a","workspaceId":"w","status":"idle"},
         "mode":{"providerId":"p","modelId":"m","effort":"high","serviceTier":null,"permissionMode":"auto"},
         "draft":{"value":null,"updatedAt":5},"pending":[],"cursor":"c9"}
        """#
        let read = try JSONDecoder().decode(AgentWire.Bootstrap.self, from: Data(readable.utf8))
        XCTAssertEqual(read.mode, AgentWire.Mode(providerId: "p", modelId: "m", effort: "high", serviceTier: nil, permissionMode: "auto"))
        XCTAssertEqual(read.draft, AgentWire.Draft(value: nil, updatedAt: 5))
    }

    /// Without its agent there is nothing to open: still a failed read.
    func testABootstrapWithoutItsAgentFails() {
        XCTAssertThrowsError(try JSONDecoder().decode(AgentWire.Bootstrap.self, from: Data(#"{"pending":[],"cursor":"c9"}"#.utf8)))
    }
}
