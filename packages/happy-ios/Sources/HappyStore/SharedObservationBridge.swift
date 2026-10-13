import Foundation
import GRDB

extension SharedValueObservation {
    /// SharedValueObservation invokes callbacks while holding its client lock.
    /// Resuming an async iterator there can race its synchronous cancellation
    /// handler, which needs that same lock to remove the shared client.
    /// Shared callbacks offer and return without waiting for the consumer.
    /// A serial drain keeps only the latest pending state, then a terminal
    /// error. This bridge is for snapshots, never an event stream.
    func startWithAsyncCallbacks(
        onError: @escaping @Sendable (Error) -> Void,
        onChange: @escaping @Sendable (Element) -> Bool
    ) -> AnyDatabaseCancellable {
        let delivery = SharedObservationDelivery<Element>(onError: onError, onChange: onChange)
        let cancellable = start(onError: { delivery.fail($0) }, onChange: { delivery.offer($0) })
        delivery.setCancellation { cancellable.cancel() }
        return AnyDatabaseCancellable { delivery.cancel() }
    }

    func valuesWithAsyncCallbacks() -> AsyncThrowingStream<Element, Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let cancellable = startWithAsyncCallbacks(onError: { error in
                continuation.finish(throwing: error)
            }, onChange: { value in
                if case .terminated = continuation.yield(value) { return false }
                return true
            })
            continuation.onTermination = { _ in cancellable.cancel() }
        }
    }
}

/// At most one value in flight, one pending value and one pending error.
/// No callback or subscription cancellation runs under the mailbox lock.
final class SharedObservationDelivery<Value: Sendable>: @unchecked Sendable {
    private enum Next {
        case value(Value, @Sendable (Value) -> Bool)
        case error(Error, @Sendable (Error) -> Void)
        case idle
    }

    private let lock = NSLock()
    private let queue = DispatchQueue(label: "HappyStore.sharedObservationBridge", qos: .userInitiated)
    private var onError: (@Sendable (Error) -> Void)?
    private var onChange: (@Sendable (Value) -> Bool)?
    private var cancellation: (@Sendable () -> Void)?
    private var pendingValue: Value?
    private var pendingError: Error?
    private var terminal = false
    private var closed = false
    private var scheduled = false

    init(onError: @escaping @Sendable (Error) -> Void, onChange: @escaping @Sendable (Value) -> Bool) {
        self.onError = onError
        self.onChange = onChange
    }

    func setCancellation(_ cancellation: @escaping @Sendable () -> Void) {
        let cancelNow = lock.withLock {
            guard !closed else { return true }
            self.cancellation = cancellation
            return false
        }
        // A cached initial callback can terminate before start() returns.
        if cancelNow { cancellation() }
    }

    func offer(_ value: Value) {
        let schedule = lock.withLock {
            guard !closed, !terminal else { return false }
            pendingValue = value
            guard !scheduled else { return false }
            scheduled = true
            return true
        }
        if schedule { queue.async { self.drain() } }
    }

    func fail(_ error: Error) {
        let schedule = lock.withLock {
            guard !closed, !terminal else { return false }
            terminal = true
            pendingError = error
            guard !scheduled else { return false }
            scheduled = true
            return true
        }
        if schedule { queue.async { self.drain() } }
    }

    func cancel() {
        let abandoned = lock.withLock {
            closed = true
            scheduled = false
            let abandoned = (pendingValue, pendingError, onChange, onError, cancellation)
            pendingValue = nil
            pendingError = nil
            onChange = nil
            onError = nil
            cancellation = nil
            return abandoned
        }
        // Release callbacks and their continuations outside the lock too.
        abandoned.4?()
        withExtendedLifetime(abandoned) { }
    }

    private func drain() {
        while true {
            let next: Next = lock.withLock {
                guard !closed else { scheduled = false; return .idle }
                if let value = pendingValue, let callback = onChange {
                    pendingValue = nil
                    return .value(value, callback)
                }
                if let error = pendingError, let callback = onError {
                    pendingError = nil
                    return .error(error, callback)
                }
                // An offer during delivery either fills this slot or starts
                // a new drain after this atomic empty/scheduled transition.
                scheduled = false
                return .idle
            }
            switch next {
            case .value(let value, let callback):
                if !callback(value) { cancel(); return }
            case .error(let error, let callback):
                callback(error)
                cancel()
                return
            case .idle:
                return
            }
        }
    }
}