import Foundation
import Dispatch

/// Debug checks are enabled by the composition root once legacy callers
/// have moved off main. Tests can record violations instead of trapping.
public enum ThreadRules {
    public enum Requirement: Equatable, Sendable { case offMain, onMain }

    private final class State: @unchecked Sendable {
        let lock = NSLock()
        let mainKey = DispatchSpecificKey<UInt8>()
        var enforced = false
        var handler: (@Sendable (Requirement) -> Void)?
        init() { DispatchQueue.main.setSpecific(key: mainKey, value: 1) }
    }
    private static let state = State()

    public static var isEnforced: Bool {
        get { state.lock.withLock { state.enforced } }
        set { state.lock.withLock { state.enforced = newValue } }
    }

    /// nil uses dispatchPrecondition when enforcement is enabled.
    public static var violationHandler: (@Sendable (Requirement) -> Void)? {
        get { state.lock.withLock { state.handler } }
        set { state.lock.withLock { state.handler = newValue } }
    }

    public static func assertOffMain(file: StaticString = #fileID, line: UInt = #line) {
        check(.offMain, file: file, line: line)
    }

    public static func assertOnMain(file: StaticString = #fileID, line: UInt = #line) {
        check(.onMain, file: file, line: line)
    }

    private static func check(_ requirement: Requirement, file: StaticString, line: UInt) {
        #if DEBUG
        let (enforced, handler) = state.lock.withLock { (state.enforced, state.handler) }
        guard enforced else { return }
        if let handler {
            let onMain = Thread.isMainThread || DispatchQueue.getSpecific(key: state.mainKey) != nil
            if (requirement == .onMain) != onMain { handler(requirement) }
        } else {
            dispatchPrecondition(condition: requirement == .onMain ? .onQueue(.main) : .notOnQueue(.main))
        }
        #endif
    }
}