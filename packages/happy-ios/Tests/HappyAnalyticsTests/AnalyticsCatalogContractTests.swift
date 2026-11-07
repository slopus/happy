import Foundation
import XCTest
@testable import HappyAnalytics
@testable import HappyCore
import HappyWire

/// The shared catalog (`docs/analytics-catalog.json`, byte-identical in the
/// desktop and Android apps) against the Swift one: every event whose
/// clients include `ios`, its properties, each property's values, whether
/// it may be null or left out, and the common properties.
final class AnalyticsCatalogContractTests: XCTestCase {
    private func catalog() throws -> JSONValue {
        var root = URL(fileURLWithPath: #filePath).resolvingSymlinksInPath()
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appendingPathComponent("docs/analytics-catalog.json"))
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// A catalog property as the Swift schema would describe it.
    private func expected(_ spec: JSONValue, shared: [String: JSONValue]) throws -> AnalyticsSchema.Property {
        func words(_ value: JSONValue?) throws -> [String] {
            let list = value?.stringValue.flatMap { shared[$0] } ?? value
            return try XCTUnwrap(list?.arrayValue?.compactMap(\.stringValue), "\(spec)")
        }
        let kind: AnalyticsSchema.Property.Kind
        if let list = spec["enum"] {
            kind = .words(try words(list))
        } else {
            switch spec["type"]?.stringValue {
            case "count": kind = .count
            case "bool": kind = .bool
            case "version": kind = .version
            case "os_version": kind = .osVersion
            default: throw XCTSkip("unknown property type \(spec)")
            }
        }
        return AnalyticsSchema.Property(kind: kind, nullable: spec["nullable"] == .bool(true), optional: spec["optional"] == .bool(true))
    }

    /// Word lists compare as sets; their order means nothing.
    private func normalized(_ property: AnalyticsSchema.Property) -> AnalyticsSchema.Property {
        var property = property
        if case .words(let words) = property.kind { property.kind = .words(words.sorted()) }
        return property
    }

    private func forIOS(_ spec: JSONValue) -> Bool {
        guard let clients = spec["clients"]?.arrayValue else { return true }
        return clients.contains(.string("ios"))
    }

    func testEveryIOSEventAndPropertyMatchesTheSharedCatalog() throws {
        let catalog = try catalog()
        let shared = try XCTUnwrap(catalog["shared_enums"]?.objectValue)
        let events = try XCTUnwrap(catalog["events"]?.objectValue).filter { forIOS($0.value) }
        XCTAssertEqual(Set(AnalyticsSchema.events.keys), Set(events.keys), "the iOS events")
        for (name, spec) in events {
            let properties = try XCTUnwrap(spec["properties"]?.objectValue, name)
            let swift = try XCTUnwrap(AnalyticsSchema.events[name], name)
            XCTAssertEqual(Set(swift.keys), Set(properties.keys), "\(name)'s properties")
            for (property, propertySpec) in properties {
                guard let ours = swift[property] else { continue }
                XCTAssertEqual(normalized(ours), normalized(try expected(propertySpec, shared: shared)), "\(name).\(property)")
            }
        }
    }

    func testCommonPropertiesMatchTheSharedCatalog() throws {
        let catalog = try catalog()
        let shared = try XCTUnwrap(catalog["shared_enums"]?.objectValue)
        let common = try XCTUnwrap(catalog["common"]?.objectValue).filter { forIOS($0.value) }
        XCTAssertEqual(Set(AnalyticsSchema.common.keys), Set(common.keys))
        for (name, spec) in common {
            guard let ours = AnalyticsSchema.common[name] else { continue }
            XCTAssertEqual(normalized(ours), normalized(try expected(spec, shared: shared)), name)
        }
    }

    /// The catalog's prefix table, row by row, is the Swift one.
    func testTheModelFamilyRuleMatchesTheSharedCatalog() throws {
        let rules = try XCTUnwrap(catalog()["model_family_rule"]?["rules"]?.arrayValue)
        let shared = rules.compactMap { rule -> [String]? in rule.arrayValue?.compactMap(\.stringValue) }
        XCTAssertEqual(shared, AnalyticsEvent.ModelFamily.rules.map { [$0.0, $0.1.rawValue] })
        XCTAssertEqual(AnalyticsEvent.ModelFamily(model: "claude_work:anthropic/claude-opus-4-5"), .claudeOpus)
        XCTAssertEqual(AnalyticsEvent.ModelFamily(model: "openai/gpt-5.1-codex"), .gpt)
        XCTAssertEqual(AnalyticsEvent.ModelFamily(model: "claude-opus-4-5"), .other)
        XCTAssertEqual(AnalyticsEvent.ModelFamily(model: "acme/secret-project-model"), .other)
        XCTAssertEqual(AnalyticsEvent.ModelFamily(model: "Anthropic/Opus"), .other)
    }

    /// Versions go as numbers only: a suffix is cut, anything else is null.
    func testVersionsAreNumbersOnly() {
        XCTAssertEqual(AnalyticsSchema.version("2.1.0-preview.3+abc"), "2.1.0")
        XCTAssertEqual(AnalyticsSchema.version("0.14.2+build.7"), "0.14.2")
        XCTAssertNil(AnalyticsSchema.version("v2.1"))
        XCTAssertNil(AnalyticsSchema.version("1.2.3.4.5"))
        XCTAssertNil(AnalyticsSchema.version(nil))
        XCTAssertEqual(AnalyticsSchema.version("2026.11.12"), "2026.11.12")
        XCTAssertEqual(AnalyticsSchema.version("2026.11.1-preview.2"), "2026.11.1")
        XCTAssertEqual(AnalyticsEvent.appCrashed(process: .app, reason: .crash, crashedVersion: "2.0.0-rc1").properties["crashed_version"], .string("2.0.0"))
    }

    /// Each typed event makes properties the schema admits whole: the enums
    /// and the allowlist say the same thing.
    func testEveryTypedEventPassesTheAllowlistUnchanged() throws {
        let samples: [AnalyticsEvent] = [
            .chatFailureShown(kind: .usageLimit, providerKind: .claude, isPool: false, target: .session, sessionClient: .happyAgent),
            .chatFailureActionClicked(kind: .rateLimited, action: .switchModel),
            .agentConnectionLost(transport: .direct, code: .unreachable, outcome: .recovered, duration: .from10sTo30s),
            .errorShown(area: .messageSend, code: .offline),
            .appCrashed(process: .app, reason: .hang, crashedVersion: "2.0.0"),
            .mobilePairingFailed(method: .direct, start: .scan, errorCode: .emojiMismatch),
            .signInFailed(method: .teamServer, errorCode: .wrongServer),
            .voiceSessionError(errorCode: .connectFailed, duration: nil),
            .paywallError(product: .pro, errorCode: .nothingToRestore),
            .appOpened(isColdStart: true, config: .init(notifications: .granted, agentsConnected: .one)),
            .messageSent(.init(source: .chat, target: .bot, sessionClient: .happyAgent, modelFamily: .claudeOpus,
                               modelProviderKind: .claude, effort: .high, botSystemKey: .chiefOfStaff, taskDepth: 1, hasAttachment: true,
                               isSteering: true)),
            .conversationCreated(source: .home, modelFamily: .gpt, modelProviderKind: .codex, effort: .medium),
            .botCreated(source: .home, result: .failed, errorCode: .offline),
            .taskCreated(result: .ok, errorCode: nil),
            .mobilePairingCompleted(method: .relay, start: nil),
            .mobilePairingCancelled(method: .direct, start: .openedLink),
            .teamServerSignedIn,
            .voiceSessionStopped(duration: .from2mTo5m),
            .paywallPresented(product: .pro),
            .paywallPurchased(product: .pro),
            .paywallRestored(product: .pro),
            .paywallCancelled(product: .pro),
        ]
        XCTAssertEqual(Set(samples.map(\.name)), Set(AnalyticsSchema.events.keys), "one sample per event")
        let common: [String: JSONValue] = [
            "client": .string("ios"), "app_version": .string("2.0.0"), "flavor": .string("preview"), "os": .string("ios"),
            "os_version": .string("26.1"), "device_class": .string("phone"), "agent_location": .string("remote"),
            "agent_os": .string("mac"), "happy_agent_version": .string("1.4.2"),
        ]
        for event in samples {
            let admitted = try XCTUnwrap(AnalyticsSchema.admit(event.name, event.properties, common: common), event.name)
            XCTAssertEqual(admitted, common.merging(event.properties) { _, own in own }, event.name)
        }
    }
}
