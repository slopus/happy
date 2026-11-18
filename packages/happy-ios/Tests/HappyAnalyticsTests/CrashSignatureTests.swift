import Foundation
import XCTest
@testable import HappyAnalytics
import HappyWire

/// A crash's signature from MetricKit's call stack JSON: the crashed
/// thread's top frames as binary and offset, the app binary's UUID, and
/// the exception's numbers and class. Nothing else of the JSON (addresses,
/// other threads' frames, sample counts) is sent.
final class CrashSignatureTests: XCTestCase {
    private static let happy = "1F43A2B4-0C5D-4E6F-8A9B-0C1D2E3F4A5B"

    private func frame(_ binary: String, _ offset: Int, uuid: String = "0D9F5B47-0E7C-3B48-9A3B-1C2D3E4F5A6B", _ sub: [[String: Any]] = []) -> [String: Any] {
        ["binaryName": binary, "binaryUUID": uuid, "offsetIntoBinaryTextSegment": offset, "address": 0x1_0000_0000 + offset, "sampleCount": 1, "subFrames": sub]
    }

    /// A MetricKit tree: thread 0 idles in Happy; thread 1, the crashed
    /// one, traps in libswift_Concurrency under Happy's code.
    private func tree(crashed: [String: Any]? = nil) throws -> Data {
        let idle = frame("Happy", 0x1000, uuid: Self.happy)
        let trap = crashed ?? frame("libdispatch.dylib", 0x3c8f4, [
            frame("libdispatch.dylib", 0x3c1a0, [
                frame("libswift_Concurrency.dylib", 0x4e2d8, [
                    frame("libswift_Concurrency.dylib", 0x4d104, [
                        frame("Happy", 0x2a4f10, uuid: Self.happy, [
                            frame("Foundation", 0x7b1c0),
                        ]),
                    ]),
                ]),
            ]),
        ])
        let json: [String: Any] = ["callStackPerThread": true, "callStacks": [
            ["threadAttributed": false, "callStackRootFrames": [idle]],
            ["threadAttributed": true, "callStackRootFrames": [trap]],
        ]]
        return try JSONSerialization.data(withJSONObject: json)
    }

    func testTheCrashedThreadsTopFiveFramesAndTheAppsUUIDAreRead() throws {
        let signature = CrashSignature(exceptionType: 6, exceptionCode: 1, signal: 5, exceptionClass: nil,
                                       callStacks: try tree(), mainBinary: "Happy")
        XCTAssertEqual(signature, CrashSignature(
            exceptionType: 6, exceptionCode: 1, signal: 5,
            frames: "libdispatch.dylib+0x3c8f4 libdispatch.dylib+0x3c1a0 libswift_Concurrency.dylib+0x4e2d8 libswift_Concurrency.dylib+0x4d104 Happy+0x2a4f10",
            binaryId: "1F43A2B40C5D4E6F8A9B0C1D2E3F4A5B"))
    }

    func testOnlyTheSignaturesFieldsGoOut() throws {
        let signature = CrashSignature(exceptionType: 1, exceptionCode: 2, signal: 11, exceptionClass: "NSInvalidArgumentException",
                                       callStacks: try tree(), mainBinary: "Happy")
        let properties = AnalyticsEvent.appCrashed(process: .app, reason: .nativeCrash, crashedVersion: "2026.11.1", signature: signature).properties
        XCTAssertEqual(Set(properties.keys), ["process", "reason", "crashed_version", "signal", "exception_type", "exception_code",
                                              "exception_class", "crash_frames", "binary_id"])
        let sent = String(decoding: try JSONEncoder().encode(properties), as: UTF8.self)
        // Neither the addresses nor the idle thread's frame.
        XCTAssertFalse(sent.contains(String(0x1_0000_0000 + 0x3c8f4)))
        XCTAssertFalse(sent.contains("0x1000"))
        XCTAssertNotNil(AnalyticsSchema.admit("app_crashed", properties, common: Self.common))
    }

    /// A crash without a signature sends what it always did.
    func testACrashWithoutASignatureIsUnchanged() {
        let properties = AnalyticsEvent.appCrashed(process: .app, reason: .hang, crashedVersion: "2026.11.1").properties
        XCTAssertEqual(properties, ["process": .string("app"), "reason": .string("hang"), "crashed_version": .string("2026.11.1")])
    }

    /// A frame whose binary name could be a path, or text, ends the list
    /// there; a class name with a message in it, an out-of-range signal or
    /// code, or a malformed UUID is left out.
    func testWhatDoesntFitIsLeftOut() throws {
        let odd = frame("Happy", 0x10, uuid: "not-a-uuid", [frame("/private/var/containers/Bundle/Happy", 0x20, [frame("Happy", 0x30)])])
        let signature = CrashSignature(exceptionType: 6, exceptionCode: 0x8BADF00D, signal: 99,
                                       exceptionClass: "NSRangeException: index 7 beyond bounds",
                                       callStacks: try tree(crashed: odd), mainBinary: "Happy")
        // The app's UUID comes from another thread's frame of it.
        XCTAssertEqual(signature, CrashSignature(exceptionType: 6, frames: "Happy+0x10", binaryId: "1F43A2B40C5D4E6F8A9B0C1D2E3F4A5B"))
        XCTAssertEqual(CrashSignature(exceptionType: nil, exceptionCode: nil, signal: nil, exceptionClass: nil,
                                      callStacks: Data("not json".utf8), mainBinary: "Happy"), CrashSignature())
    }

    func testTheSchemaAdmitsOnlyCatalogShapedSignatures() {
        func admits(_ name: String, _ value: JSONValue) -> Bool {
            AnalyticsSchema.admit("app_crashed", ["process": .string("app"), "reason": .string("crash"), "crashed_version": .null, name: value],
                                  common: Self.common) != nil
        }
        XCTAssertTrue(admits("crash_frames", .string("Happy+0x2a4f10")))
        XCTAssertTrue(admits("crash_frames", .string("o3.f.a:12 com.slopus.happy.Main.<init>:0")))
        XCTAssertFalse(admits("crash_frames", .string("")))
        XCTAssertFalse(admits("crash_frames", .string("a+0x1 a+0x1 a+0x1 a+0x1 a+0x1 a+0x1")))
        XCTAssertFalse(admits("crash_frames", .string("Happy+0x1  Happy+0x2")))
        XCTAssertFalse(admits("crash_frames", .string("/var/mobile/Happy+0x1")))
        XCTAssertFalse(admits("crash_frames", .string("Happy+0x" + String(repeating: "f", count: 13))))
        XCTAssertTrue(admits("binary_id", .string("1F43A2B40C5D4E6F8A9B0C1D2E3F4A5B")))
        XCTAssertFalse(admits("binary_id", .string("1F43A2B4-0C5D-4E6F-8A9B-0C1D2E3F4A5B")))
        XCTAssertTrue(admits("exception_class", .string("NSInvalidArgumentException")))
        XCTAssertFalse(admits("exception_class", .string("unrecognized selector sent to instance 0x283")))
        XCTAssertTrue(admits("signal", .number(5)))
        XCTAssertFalse(admits("signal", .number(0)))
        XCTAssertFalse(admits("exception_code", .number(-1)))
    }

    private static let common: [String: JSONValue] = [
        "client": .string("ios"), "app_version": .string("2026.11.1"), "flavor": .string("standard"), "os": .string("ios"),
        "os_version": .string("26.1"), "device_class": .string("phone"), "agent_location": .null, "agent_os": .null, "happy_agent_version": .null,
    ]
}
