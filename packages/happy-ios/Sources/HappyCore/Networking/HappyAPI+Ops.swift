import Foundation
import HappyWire

extension HappyAPI {
    /// Ports apiPush.registerPushToken.
    public func registerPushToken(_ token: String) async throws {
        let request = try makeRequest("POST", "/v1/push-tokens", body: JSONValue.object(["token": .string(token)]).encoded())
        try await opsSuccess(request)
    }

    /// Ports ops.ts machineDelete.
    public func deleteMachine(id: String) async throws {
        try await opsSuccess(makeRequest("DELETE", "/v1/machines/\(Self.escape(id))"), requireConfirmation: false)
    }

    /// Ports apiPush.unregisterPushToken, including the success acknowledgement.
    public func unregisterPushToken(_ token: String) async throws {
        try await opsSuccess(makeRequest("DELETE", "/v1/push-tokens/\(Self.escape(token))"))
    }

    private func opsSuccess(_ request: HTTPRequest, requireConfirmation: Bool = true) async throws {
        let response = try await transport.send(request)
        if response.status == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(response.status) else {
            throw APIError.http(status: response.status, body: String(decoding: response.body.prefix(512), as: UTF8.self))
        }
        guard requireConfirmation else { return }
        let result = try JSONValue.decode(response.body)
        guard result["success"]?.boolValue == true else { throw SessionActionError.failed("Server did not confirm the operation") }
    }
}
