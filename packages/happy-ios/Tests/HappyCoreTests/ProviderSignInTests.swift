import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// Provider sign-in (happy-agent API.md "Provider sign-in"): a computer's
/// Codex, Claude and Grok accounts, where each credential comes from, and
/// the sign-in followed to its end, the greater version kept, with no code
/// or token kept on the phone.
final class ProviderSignInTests: XCTestCase {
    static let config = #"""
    {"config":{"defaults":{"providerId":"codex_work","modelId":"m"},"models":{},"providers":{
      "codex_work":{"type":"codex","name":"Work ChatGPT","enabled":true,"credential":{"source":"system","methods":["device","browser"],"acceptsToken":false}},
      "bedrock":{"type":"bedrock","enabled":true},
      "claude_home":{"type":"claude","enabled":true,"credential":{"source":"internal","methods":["browser"],"acceptsToken":true}},
      "grok":{"type":"grok","enabled":true,"credential":{"source":"vault","methods":["device"],"acceptsToken":false}},
      "codex_old":{"type":"codex","enabled":true}
    }}}
    """#

    static func signIn(_ id: String = "claude_home", cli: String = "claude", version: String = "01991f3a-5c1e-7000-8000-000000000001",
                       operation: String = "null", account: String = "null", installed: Bool = true) -> String {
        #"{"providerId":"\#(id)","cliId":"\#(cli)","installed":\#(installed),"credential":{"source":"internal","methods":["browser"],"acceptsToken":true},"account":\#(account),"operation":\#(operation),"version":"\#(version)","updatedAt":1755400000000}"#
    }

    static func operation(_ status: String, method: String = "device", userCode: String? = "ABCD-1234", acceptsCode: Bool = false, error: String = "null") -> String {
        let code = userCode.map { "\"\($0)\"" } ?? "null"
        return #"{"id":"op1","kind":"sign_in","status":"\#(status)","message":"Signing in","authorization":{"method":"\#(method)","url":"https://auth.openai.com/codex/device","userCode":\#(code),"openedByProgram":false,"acceptsCode":\#(acceptsCode),"expiresAt":1755400600000},"output":[],"error":\#(error),"startedAt":1,"finishedAt":null}"#
    }

    func testTheAccountsAreTheSubscriptionOnesInTheDaemonsOrder() {
        let accounts = ProviderAccount.list(config: Data(Self.config.utf8))
        XCTAssertEqual(accounts.map(\.id), ["codex_work", "claude_home", "grok"], "bedrock has nothing to sign in to; an older daemon's account has no credential")
        XCTAssertEqual(accounts[0].name, "Work ChatGPT")
        XCTAssertEqual(accounts.map(\.credential.source), [.system, .internal, .configured], "an unknown source reads as configured")
        XCTAssertEqual(accounts.map(\.credential.acceptsToken), [false, true, false])
    }

    func testAPhoneSignsInWithADeviceCodeOrClaudesPastedCode() {
        XCTAssertEqual(ProviderCredential(source: .system, methods: ["browser", "device"]).phoneMethod(cli: "codex"), "device")
        XCTAssertEqual(ProviderCredential(source: .system, methods: ["browser"]).phoneMethod(cli: "claude"), "browser")
        XCTAssertNil(ProviderCredential(source: .system, methods: ["browser"]).phoneMethod(cli: "codex"), "Codex's browser page is served on the computer")
        XCTAssertNil(ProviderCredential(source: .system, methods: ["browser"]).phoneMethod(cli: "grok"))
        XCTAssertNil(ProviderCredential(source: .system).phoneMethod(cli: "claude"))
    }

    func testTheSignInObjectAndTheGreaterVersionKept() throws {
        let older = try XCTUnwrap(ProviderSignIn(try JSONValue.decode(Data(Self.signIn(version: "01991f3a-5c1e-7000-8000-000000000001").utf8))))
        let newer = try XCTUnwrap(ProviderSignIn(try JSONValue.decode(Data(Self.signIn(version: "01991f3a-5c1f-7000-8000-000000000000",
            operation: Self.operation("waiting"), account: #"{"email":"ada@example.com","plan":"Max"}"#).utf8))))
        XCTAssertNil(older.operation)
        XCTAssertNil(older.account)
        XCTAssertEqual(newer.account, ProviderSignIn.Account(email: "ada@example.com", plan: "Max"))
        XCTAssertEqual(newer.operation?.userCode, "ABCD-1234")
        XCTAssertEqual(newer.operation?.url?.absoluteString, "https://auth.openai.com/codex/device")
        XCTAssertEqual(newer.operation?.status, .waiting)

        var kept: [String: ProviderSignIn] = [:]
        XCTAssertTrue(ProviderSignIn.keep(newer, in: &kept))
        XCTAssertFalse(ProviderSignIn.keep(older, in: &kept), "an older snapshot arriving after an event replaced nothing")
        XCTAssertEqual(kept["claude_home"], newer)

        let event = try JSONValue.decode(Data(#"{"type":"provider_sign_in.updated","payload":{"providerSignIn":\#(Self.signIn()),"mutationId":"m"}}"#.utf8))
        XCTAssertEqual(ProviderSignIn.fromEvent(event)?.providerId, "claude_home")
        XCTAssertNil(ProviderSignIn.fromEvent(try JSONValue.decode(Data(#"{"type":"config.updated","payload":{}}"#.utf8))))
    }

    func testWhatTheScreenShowsForEachStep() throws {
        func phase(_ operation: String) throws -> ProviderSignIn.Phase {
            try XCTUnwrap(ProviderSignIn(try JSONValue.decode(Data(Self.signIn(operation: operation).utf8)))).phase
        }
        XCTAssertEqual(try phase("null"), .starting)
        XCTAssertEqual(try phase(#"{"id":"op1","kind":"sign_in","status":"running","message":"Starting","authorization":null,"output":[],"error":null,"startedAt":1,"finishedAt":null}"#), .starting)
        XCTAssertEqual(try phase(Self.operation("waiting")), .device(code: "ABCD-1234", url: URL(string: "https://auth.openai.com/codex/device")))
        XCTAssertEqual(try phase(Self.operation("waiting", method: "browser", userCode: nil, acceptsCode: true)), .pasteCode(url: URL(string: "https://auth.openai.com/codex/device")))
        XCTAssertEqual(try phase(Self.operation("waiting", method: "browser", userCode: nil)), .onComputer, "Codex's browser page is on the computer")
        XCTAssertEqual(try phase(Self.operation("failed", error: #"{"code":"save_failed","message":"Couldn't write runtime.toml."}"#)),
                       .failed(code: "save_failed", message: "Couldn't write runtime.toml."))
        XCTAssertEqual(try phase(Self.operation("cancelled")), .cancelled)
        let insecure = Self.operation("waiting").replacingOccurrences(of: "https://", with: "http://")
        XCTAssertEqual(try phase(insecure), .device(code: "ABCD-1234", url: nil), "only an https page opens")
    }

    func testTheRoutesTheirBodiesAndNoSecretKept() async throws {
        let server = ProvidersServer()
        let answer = #"{"providerSignIn":\#(Self.signIn("work codex", cli: "codex", operation: Self.operation("running")))}"#
        await server.answer("POST /v0/providers/work%20codex/sign-in", 200, answer)
        await server.answer("GET /v0/providers/work%20codex/sign-in", 200, answer)
        await server.answer("POST /v0/providers/work%20codex/sign-in/code", 200, answer)
        await server.answer("POST /v0/providers/work%20codex/sign-in/cancel", 200, answer)
        await server.answer("PUT /v0/providers/work%20codex/token", 200, answer)
        let client = AgentClient(transport: server, token: "t")

        _ = try await client.startProviderSignIn("work codex", method: "device")
        _ = try await client.providerSignIn("work codex")
        _ = try await client.sendProviderSignInCode("work codex", code: "the-code")
        _ = try await client.cancelProviderSignIn("work codex")
        let saved = try await client.saveProviderToken("work codex", token: "sk-ant-oat01-x")
        XCTAssertEqual(saved.providerId, "work codex")

        let routes = await server.routes
        XCTAssertEqual(routes, ["POST /v0/providers/work%20codex/sign-in", "GET /v0/providers/work%20codex/sign-in",
                                "POST /v0/providers/work%20codex/sign-in/code", "POST /v0/providers/work%20codex/sign-in/cancel",
                                "PUT /v0/providers/work%20codex/token"])
        let bodies = await server.bodies
        XCTAssertEqual(bodies[0]["method"], "device")
        XCTAssertEqual(bodies[1]["code"], "the-code")
        XCTAssertEqual(bodies[3]["token"], "sk-ant-oat01-x")
        XCTAssertTrue(bodies.allSatisfy { $0["mutationId"]?.hasPrefix("ios-") == true })
        XCTAssertEqual(Set(bodies[0].keys), ["method", "mutationId"])

        _ = try await client.startProviderSignIn("work codex", method: nil)
        let started = await server.bodies.last
        XCTAssertEqual(started.map { Set($0.keys) }, ["mutationId"], "no method: the daemon uses its first")
    }

    func testRefusalsSayWhy() async throws {
        let server = ProvidersServer()
        let client = AgentClient(transport: server, token: "t")
        func refusal(_ status: Int, _ body: String) async -> ProviderSignInRefusal {
            await server.answer("POST /v0/providers/claude/sign-in", status, body)
            do { _ = try await client.startProviderSignIn("claude", method: "browser"); return .other("no error") }
            catch { return ProviderSignInRefusal(error) }
        }
        let owner = await refusal(403, #"{"error":"Only the team owner can sign accounts in.","code":"forbidden"}"#)
        XCTAssertEqual(owner, .ownerOnly)
        let missing = await refusal(409, #"{"error":"Claude Code is not installed.","code":"not_installed","providerSignIn":\#(Self.signIn(installed: false))}"#)
        XCTAssertEqual(missing, .notInstalled)
        let unsupported = await refusal(409, #"{"error":"Nothing to sign in to.","code":"not_supported"}"#)
        XCTAssertEqual(unsupported, .notSupported)
        let conflict = await refusal(409, #"{"error":"Not waiting for a code.","code":"conflict"}"#)
        XCTAssertEqual(conflict, .conflict)
        let invalid = await refusal(400, #"{"error":"Unknown method.","code":"invalid_request"}"#)
        XCTAssertEqual(invalid, .invalid("Unknown method."))
        let other = await refusal(500, #"{"error":"Boom.","code":"internal"}"#)
        XCTAssertEqual(other, .other("Boom."))
    }

    func testTheCapabilityAndWhetherEachAccountWorks() async throws {
        let server = ProvidersServer()
        await server.answer("GET /v0/health", 200, #"{"ready":true,"capabilities":{"providerSignIn":true}}"#)
        await server.answer("GET /v0/usage", 200, #"{"providers":[{"providerId":"codex_work","signIn":"signed_out"},{"providerId":"claude_home","signIn":"signed_in"},{"providerId":"grok"}]}"#)
        await server.answer("GET /v0/config", 200, Self.config)
        let client = AgentClient(transport: server, token: "t")
        let served = try await client.servesProviderSignIn()
        XCTAssertTrue(served)
        let statuses = try await client.providerAccountHealth()
        XCTAssertEqual(statuses.mapValues(\.signIn), ["codex_work": "signed_out", "claude_home": "signed_in", "grok": nil])
        let accounts = try await client.providerAccounts()
        XCTAssertEqual(accounts.count, 3)
        XCTAssertEqual(accounts.map(\.enabled), [true, true, true])

        await server.answer("PATCH /v0/config", 200, Self.config)
        try await client.setProviderEnabled("grok", false)
        let patched = await server.rawBodies.last
        XCTAssertEqual(patched, try JSONValue.decode(Data(#"{"providers":{"grok":{"enabled":false}}}"#.utf8)))

        let older = ProvidersServer()
        await older.answer("GET /v0/health", 200, #"{"ready":true,"capabilities":{}}"#)
        let olderServed = try await AgentClient(transport: older, token: "t").servesProviderSignIn()
        XCTAssertFalse(olderServed, "without the capability the page is hidden")
    }

    static func health(_ json: String) throws -> ProviderAccountHealth {
        ProviderAccountHealth(try JSONValue.decode(Data(json.utf8)))
    }

    func testTheNewerLoginFieldsAndAnOlderDaemonsReading() throws {
        let newer = try Self.health(#"{"providerId":"a","signIn":"signed_in","refreshedAt":1000,"usage":{"planName":"Pro"},"lastUsedAt":2000,"login":{"refreshedAt":3000,"expiresAt":4000,"refreshError":{"status":503,"code":null,"permanent":false,"since":5000,"at":6000}}}"#)
        XCTAssertEqual(newer.lastUsed, .at(Date(timeIntervalSince1970: 2)))
        XCTAssertEqual(newer.login?.refreshedAt, Date(timeIntervalSince1970: 3))
        XCTAssertEqual(newer.login?.expiresAt, Date(timeIntervalSince1970: 4))
        XCTAssertEqual(newer.login?.refreshError, .init(status: 503, code: nil, permanent: false, since: Date(timeIntervalSince1970: 5), at: Date(timeIntervalSince1970: 6)))
        XCTAssertEqual(newer.login?.refreshError?.reason, "HTTP 503")
        XCTAssertEqual(newer.planName, "Pro")
        let never = try Self.health(#"{"providerId":"a","signIn":"signed_in","lastUsedAt":null,"login":null}"#)
        XCTAssertEqual(never.lastUsed, .never, "null is never used; absent is an older daemon")
        XCTAssertNil(never.login)
        let older = try Self.health(#"{"providerId":"a","signIn":"unknown","refreshedAt":1000}"#)
        XCTAssertNil(older.lastUsed)
        XCTAssertEqual(older.checkedAt, Date(timeIntervalSince1970: 1))
    }

    func testTheRowSaysTheFirstThatApplies() throws {
        let since = Date(timeIntervalSince1970: 5), at = Date(timeIntervalSince1970: 6)
        let permanent = try Self.health(#"{"signIn":"signed_in","login":{"refreshedAt":null,"expiresAt":null,"refreshError":{"status":400,"code":"invalid_grant","permanent":true,"since":5000,"at":6000}}}"#)
        let transient = try Self.health(#"{"signIn":"signed_in","lastUsedAt":1000,"login":{"refreshedAt":null,"expiresAt":null,"refreshError":{"status":503,"code":null,"permanent":false,"since":5000,"at":6000}}}"#)
        let working = try Self.health(#"{"signIn":"signed_in","refreshedAt":9000,"lastUsedAt":1000,"login":{"refreshedAt":3000,"expiresAt":null,"refreshError":null}}"#)

        XCTAssertEqual(ProviderAccountStatus(enabled: false, source: .system, health: permanent), .off, "off comes first")
        XCTAssertEqual(ProviderAccountStatus(enabled: true, source: .internal, health: permanent), .needsSignIn(since: since))
        XCTAssertEqual(ProviderAccountStatus(enabled: true, source: .internal, health: try Self.health(#"{"signIn":"signed_out"}"#)), .needsSignIn(since: nil))
        XCTAssertEqual(ProviderAccountStatus(enabled: true, source: .internal, health: transient), .refreshFailed(reason: "HTTP 503", at: at))
        let fine = ProviderAccountStatus(enabled: true, source: .system, health: working)
        XCTAssertEqual(fine, .working(signedIn: true, system: true, used: .at(Date(timeIntervalSince1970: 1)), refreshed: Date(timeIntervalSince1970: 3), checked: nil),
                       "a newer daemon's reading time isn't shown beside its login")
        let older = ProviderAccountStatus(enabled: true, source: .configured, health: try Self.health(#"{"signIn":"unknown","refreshedAt":9000}"#))
        XCTAssertEqual(older, .working(signedIn: false, system: false, used: nil, refreshed: nil, checked: Date(timeIntervalSince1970: 9)))
        XCTAssertEqual([ProviderAccountStatus.off, .needsSignIn(since: nil), .refreshFailed(reason: nil, at: at), fine, older].map(\.dot), [.grey, .red, .amber, .green, .grey])
    }

    func testExpiryWarnsOnlyWhileRenewingFailsWithinADay() throws {
        let now = Date(timeIntervalSince1970: 100_000)
        func login(expires: Double, error: Bool) throws -> ProviderAccountHealth {
            let failing = error ? #"{"status":503,"code":null,"permanent":false,"since":1000,"at":2000}"# : "null"
            return try Self.health(#"{"signIn":"signed_in","login":{"refreshedAt":null,"expiresAt":\#(Int(expires * 1000)),"refreshError":\#(failing)}}"#)
        }
        XCTAssertEqual(ProviderAccountStatus.expiryWarning(try login(expires: 100_000 + 3 * 3600, error: true), now: now), Date(timeIntervalSince1970: 100_000 + 3 * 3600))
        XCTAssertNil(ProviderAccountStatus.expiryWarning(try login(expires: 100_000 + 3 * 3600, error: false), now: now), "renewal is working: no warning")
        XCTAssertNil(ProviderAccountStatus.expiryWarning(try login(expires: 100_000 + 30 * 3600, error: true), now: now), "more than a day away")
    }
}
