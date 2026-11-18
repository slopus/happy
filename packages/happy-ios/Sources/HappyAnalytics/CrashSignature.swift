import Foundation
import HappyWire

/// What `app_crashed` tells of a crash beyond its reason: the Mach
/// exception and signal, an Objective-C exception's class, and the crashed
/// thread's top frames as `binary+0xoffset` with the app binary's UUID, so
/// a dSYM can symbolicate them later. Read from MetricKit's numbers and its
/// call stack JSON (`MXCallStackTree.jsonRepresentation()`), of which only
/// `threadAttributed`, `binaryName`, `binaryUUID`,
/// `offsetIntoBinaryTextSegment` and `subFrames` are looked at: never an
/// address, a message, a path or a thread's name. A value outside what the
/// catalog allows is nil.
public struct CrashSignature: Equatable, Sendable {
    static let maxFrames = 5

    var exceptionType: Int?
    var exceptionCode: Int?
    var signal: Int?
    var exceptionClass: String?
    var frames: String?
    var binaryId: String?

    init(exceptionType: Int? = nil, exceptionCode: Int? = nil, signal: Int? = nil,
         exceptionClass: String? = nil, frames: String? = nil, binaryId: String? = nil) {
        self.exceptionType = exceptionType
        self.exceptionCode = exceptionCode
        self.signal = signal
        self.exceptionClass = exceptionClass
        self.frames = frames
        self.binaryId = binaryId
    }

    /// `callStacks` is the call stack tree's JSON; `mainBinary`, the app's
    /// executable name, whose UUID is the one sent.
    init(exceptionType: Int?, exceptionCode: Int?, signal: Int?, exceptionClass: String?, callStacks: Data?, mainBinary: String?) {
        self.exceptionType = exceptionType.flatMap(Self.count)
        self.exceptionCode = exceptionCode.flatMap(Self.count)
        self.signal = signal.flatMap { (1...64).contains($0) ? $0 : nil }
        self.exceptionClass = exceptionClass.flatMap { Self.isClassName($0) ? $0 : nil }
        guard let callStacks, let tree = try? JSONDecoder().decode(JSONValue.self, from: callStacks),
              let stacks = tree["callStacks"]?.arrayValue else { return }
        // The crashed thread is the one MetricKit attributes the crash to.
        let crashed = stacks.first { $0["threadAttributed"]?.boolValue == true }
        // Top first: each frame's caller is its first sub-frame.
        var line: [String] = []
        var frame = crashed?["callStackRootFrames"]?.arrayValue?.first
        while let current = frame, line.count < Self.maxFrames, let text = Self.frame(current) {
            line.append(text)
            frame = current["subFrames"]?.arrayValue?.first
        }
        frames = line.isEmpty ? nil : line.joined(separator: " ")
        // The app's UUID from wherever its code is on the stacks, the crashed thread first.
        if let mainBinary {
            for stack in [crashed].compactMap({ $0 }) + stacks {
                if let uuid = Self.uuid(of: mainBinary, in: stack["callStackRootFrames"]?.arrayValue ?? []) {
                    binaryId = uuid
                    break
                }
            }
        }
    }

    var properties: [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        if let exceptionType { out["exception_type"] = .number(Double(exceptionType)) }
        if let exceptionCode { out["exception_code"] = .number(Double(exceptionCode)) }
        if let signal { out["signal"] = .number(Double(signal)) }
        if let exceptionClass { out["exception_class"] = .string(exceptionClass) }
        if let frames { out["crash_frames"] = .string(frames) }
        if let binaryId { out["binary_id"] = .string(binaryId) }
        return out
    }

    private static func count(_ value: Int) -> Int? { (0...AnalyticsSchema.maxCount).contains(value) ? value : nil }

    static func isClassName(_ text: String) -> Bool { text.wholeMatch(of: /[A-Za-z_$][A-Za-z0-9_$.]{0,127}/) != nil }
    static func isBinaryName(_ text: String) -> Bool { text.wholeMatch(of: /[A-Za-z0-9_.$\-]{1,64}/) != nil }

    /// `binary+0xoffset`, or nil when the frame lacks either or one doesn't fit.
    private static func frame(_ frame: JSONValue) -> String? {
        guard let name = frame["binaryName"]?.stringValue, isBinaryName(name),
              let offset = frame["offsetIntoBinaryTextSegment"]?.numberValue.flatMap(UInt64.init(exactly:)),
              offset < 1 << 48 else { return nil }
        return "\(name)+0x\(String(offset, radix: 16))"
    }

    /// The first `binary` frame's UUID, 32 upper-case hex digits.
    private static func uuid(of binary: String, in frames: [JSONValue]) -> String? {
        for frame in frames {
            if frame["binaryName"]?.stringValue == binary, let raw = frame["binaryUUID"]?.stringValue {
                let hex = raw.replacingOccurrences(of: "-", with: "").uppercased()
                return hex.wholeMatch(of: /[0-9A-F]{32}/) != nil ? hex : nil
            }
            if let found = uuid(of: binary, in: frame["subFrames"]?.arrayValue ?? []) { return found }
        }
        return nil
    }
}
