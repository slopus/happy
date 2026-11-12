import Foundation
import HappyWire

/// One event reader normally, two only while coming back from a short
/// background. Selection happens before yielding, so a losing reader can
/// never deliver a frame after the winner. Cancellation closes its flow,
/// not the shared realtime tunnel.
///
/// The race is bounded: if neither brings a frame within `limit`, both
/// are closed and the stream ends as one gone silent, to be opened again
/// like any other.
actor EventStreamRace {
    typealias Open = @Sendable (String?) async throws -> AsyncThrowingStream<ServerSentEvent, Error>
    nonisolated let stream: AsyncThrowingStream<ServerSentEvent, Error>
    private let output: AsyncThrowingStream<ServerSentEvent, Error>.Continuation
    private let open: Open
    private let limit: Duration
    private var readers: [UUID: Task<Void, Never>] = [:]
    private var winner: UUID?
    private var deadline: Task<Void, Never>?
    private var closed = false

    init(limit: Duration = .seconds(5), open: @escaping Open) {
        self.open = open
        self.limit = limit
        (stream, output) = AsyncThrowingStream.makeStream()
    }

    func start(after cursor: String?) { add(after: cursor) }

    func race(after cursor: String?) {
        guard !closed else { return }
        // More than one foreground notification must not multiply readers.
        guard readers.count == 1 else { return }
        winner = nil
        add(after: cursor)
        deadline = Task { [weak self, limit] in
            guard (try? await Task.sleep(for: limit)) != nil else { return }
            await self?.expire()
        }
    }

    private func expire() {
        guard !closed, winner == nil else { return }
        finish(PairingError.unavailable)
    }

    private func add(after cursor: String?) {
        guard !closed else { return }
        let id = UUID(), open = open
        readers[id] = Task { [weak self] in
            do {
                let source = try await open(cursor)
                for try await frame in source {
                    guard !Task.isCancelled else { return }
                    await self?.receive(frame, from: id)
                }
                await self?.ended(id, error: nil)
            } catch { await self?.ended(id, error: error) }
        }
    }

    private func receive(_ frame: ServerSentEvent, from id: UUID) {
        guard !closed, readers[id] != nil else { return }
        if winner == nil, readers.count > 1 {
            // A malformed frame must not beat a working connection.
            guard let value = try? JSONValue.decode(Data(frame.data.utf8)), value.objectValue != nil else { return }
            if frame.event == "hello", value["cursor"]?.stringValue == nil { return }
        }
        if winner == nil {
            winner = id
            deadline?.cancel(); deadline = nil
            for (other, task) in readers where other != id { task.cancel() }
            readers = readers.filter { $0.key == id }
        }
        guard winner == id else { return }
        output.yield(frame)
    }

    private func ended(_ id: UUID, error: (any Error)?) {
        guard readers.removeValue(forKey: id) != nil, !closed else { return }
        guard readers.isEmpty else { return }
        finish(error)
    }

    private func finish(_ error: (any Error)?) {
        closed = true
        deadline?.cancel(); deadline = nil
        readers.values.forEach { $0.cancel() }
        readers.removeAll()
        if let error { output.finish(throwing: error) } else { output.finish() }
    }

    func close() {
        guard !closed else { return }
        finish(nil)
    }
}
