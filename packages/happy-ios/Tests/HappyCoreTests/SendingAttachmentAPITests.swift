import Foundation
import XCTest
@testable import HappyCore
import HappyWire

final class SendingAttachmentAPITests: XCTestCase {
    func testMultipartUploadDoesNotSendAccountTokenToStorage() async throws {
        let http = FakeHTTP()
        http.onRaw("POST /v1/sessions/s/attachments/request-upload", """
        {"ref":"ref","uploadUrl":"https://storage.example.test/upload","method":"POST",
        "formFields":{"policy":"p","Content-Type":"application/octet-stream"}}
        """)
        http.on("POST /upload") { request in
            XCTAssertEqual(request.url.host, "storage.example.test")
            XCTAssertNil(request.headers["Authorization"])
            let data = try XCTUnwrap(request.body)
            XCTAssertTrue(data.range(of: Data("name=\"policy\"\r\n\r\np\r\n".utf8)) != nil)
            XCTAssertTrue(data.range(of: Data([0, 255, 0, 1])) != nil)
            XCTAssertTrue(data.range(of: Data("name=\"file\"; filename=\"blob\"".utf8)) != nil)
            return (204, Data())
        }
        let api = testAPI(http)
        let upload = try await api.requestAttachmentUpload(sessionId: "s", filename: "f", size: 4)
        try await api.uploadEncryptedBlob(Data([0, 255, 0, 1]), upload: upload)
    }

    func testLoopbackRewritesSchemeHostAndPortAndDownloadAuthenticates() async throws {
        let http = FakeHTTP()
        http.onRaw("POST /v1/sessions/s/attachments/request-upload", #"{"ref":"ref","uploadUrl":"http://localhost:3000/blob","method":"PUT"}"#)
        http.onRaw("POST /v1/sessions/s/attachments/request-download", #"{"downloadUrl":"http://127.0.0.1:3000/blob"}"#)
        http.on("GET /blob") { request in
            XCTAssertEqual(request.url.absoluteString, "https://api.example.test/blob")
            XCTAssertEqual(request.headers["Authorization"], "Bearer token-1")
            return (200, Data([1, 2, 3]))
        }
        let api = testAPI(http)
        let upload = try await api.requestAttachmentUpload(sessionId: "s", filename: "f", size: 4)
        XCTAssertEqual(upload.uploadUrl, "https://api.example.test/blob")
        let data = try await api.downloadEncryptedAttachment(sessionId: "s", ref: "ref")
        XCTAssertEqual(data, Data([1, 2, 3]))
    }

    func testHostPrefixCannotReceiveBearerToken() async throws {
        let http = FakeHTTP()
        http.onRaw("POST /v1/sessions/s/attachments/request-upload", #"{"ref":"ref","uploadUrl":"https://api.example.test.evil/blob","method":"PUT"}"#)
        http.on("PUT /blob") { request in
            XCTAssertNil(request.headers["Authorization"])
            return (200, Data())
        }
        let api = testAPI(http)
        let upload = try await api.requestAttachmentUpload(sessionId: "s", filename: "f", size: 4)
        try await api.uploadEncryptedBlob(Data([1]), upload: upload)
    }
}
