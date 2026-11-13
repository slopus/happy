import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// A team's own provider (happy-cluster `PUT /v0/providers/:id`): its ID
/// made from its name, and one request carrying the endpoint, its model
/// and the key.
final class CustomProviderTests: XCTestCase {
    func testTheIDComesFromTheName() {
        func id(_ name: String) -> String { CustomProvider(name: name, baseUrl: "", model: "", apiKey: "").id }
        XCTAssertEqual(id("Together AI"), "together-ai")
        XCTAssertEqual(id("  My  Llama (prod) "), "my-llama-prod")
        XCTAssertEqual(id("42 Labs"), "labs", "an ID starts with a letter")
        XCTAssertEqual(id("OpenAI"), "openai-custom", "a built-in provider's ID was taken")
        XCTAssertEqual(id("Ω"), "custom")
        XCTAssertEqual(id("x"), "custom-x")
        XCTAssertLessThanOrEqual(id(String(repeating: "abc ", count: 20)).count, 32)
        XCTAssertFalse(id(String(repeating: "abc ", count: 20)).hasSuffix("-"))
    }

    func testOnlyAnHttpsEndpointWithEveryPartIsComplete() {
        XCTAssertTrue(CustomProvider(name: "Together", baseUrl: "https://api.together.xyz/v1", model: "llama-4", apiKey: "k").isComplete)
        XCTAssertFalse(CustomProvider(name: "Together", baseUrl: "http://api.together.xyz/v1", model: "llama-4", apiKey: "k").isComplete)
        XCTAssertFalse(CustomProvider(name: "Together", baseUrl: "https://api.together.xyz/v1", model: " ", apiKey: "k").isComplete)
        XCTAssertFalse(CustomProvider(name: "Together", baseUrl: "https://api.together.xyz/v1", model: "llama-4", apiKey: "").isComplete)
    }

    func testItIsPutWithItsModelAndKey() async throws {
        let server = ProvidersServer()
        await server.answer("PUT /v0/providers/together", 200, #"{"providerId":"together","credentials":"available"}"#)
        try await AgentClient(transport: server, token: "t")
            .putCustomProvider(CustomProvider(name: " Together ", baseUrl: "https://api.together.xyz/v1 ", model: "llama-4", apiKey: "sk-1 "))
        let bodies = await server.rawBodies
        XCTAssertEqual(bodies.last, .object([
            "name": .string("Together"), "baseUrl": .string("https://api.together.xyz/v1"), "protocol": .string("openai_responses"),
            "models": .array([.object(["id": .string("llama-4"), "name": .string("llama-4"), "inputTypes": .array([.string("text")])])]),
            "apiKey": .string("sk-1"),
        ]))
    }
}
