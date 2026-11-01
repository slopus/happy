import Foundation
import XCTest
@testable import HappyCore
import HappyWire

final class TodoTextTests: XCTestCase {
    func testTextIsTrimmedAndControlCharactersBecomeSpaces() {
        XCTAssertEqual(TodoText.normalized("  Buy\u{0007}milk \n"), "Buy milk")
        XCTAssertNil(TodoText.normalized("   \n\t"))
        XCTAssertNil(TodoText.normalized("# "))
        XCTAssertEqual(TodoText.normalized(String(repeating: "a", count: 10_050))?.count, 10_000)
    }

    func testAHeadingStaysOneAndATodoNeverBecomesOne() {
        XCTAssertEqual(TodoText.normalized("#   Groceries  "), "# Groceries")
        XCTAssertEqual(TodoText.heading("# Groceries"), "Groceries")
        // Trimming "  # milk" would make it a heading: a space keeps it a todo.
        XCTAssertEqual(TodoText.normalized("  # milk"), " # milk")
        XCTAssertNil(TodoText.heading(" # milk"))
        for todo in ["## Title", "#Title", "#\tTitle"] { XCTAssertNil(TodoText.heading(todo), todo) }
    }
}

final class TodoOrderTests: XCTestCase {
    func testKeysFallBetweenTheirNeighboursByBytes() {
        let cases: [(String?, String?)] = [(nil, nil), (nil, "5"), (nil, "0"), ("5", nil), ("9", nil), ("4", "5"), ("44", "45"), ("45", "5"), ("1", "2"), ("09", "1")]
        for (a, b) in cases {
            let key = TodoOrder.key(between: a, and: b)
            if let a { XCTAssertTrue(TodoOrder.precedes(a, key), "\(a) < \(key)") }
            if let b { XCTAssertTrue(TodoOrder.precedes(key, b), "\(key) < \(b)") }
        }
        XCTAssertEqual(TodoOrder.key(between: nil, and: nil), "4")
        XCTAssertEqual(TodoOrder.key(between: "4", and: "5"), "44")
    }

    func testListsSortAsTheComputerSortsThem() {
        let a = TodoItem(id: "b", surfaceId: "s", text: "", orderKey: "5")
        let b = TodoItem(id: "a", surfaceId: "s", text: "", orderKey: "5")
        let c = TodoItem(id: "c", surfaceId: "s", text: "", orderKey: "45")
        XCTAssertEqual([a, b, c].sorted(by: TodoOrder.active).map(\.id), ["c", "a", "b"])
        XCTAssertTrue(TodoOrder.newer("01991f3a-5c1e-7000-8000-2f9a1b3c4d5f", than: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e"))
    }
}

final class TodoReducerTests: XCTestCase {
    private let s = "s0000000000000000000000a"

    private func todo(_ id: String, _ text: String = "x", _ status: TodoItem.Status = .active, key: String? = "5", version: String = "0001") -> TodoItem {
        TodoItem(id: id, surfaceId: s, text: text, status: status, orderKey: status == .active ? key : nil, completedAt: status == .completed ? 10 : nil, deletedAt: status == .deleted ? 20 : nil, version: version)
    }

    private func op(_ id: String, _ kind: TodoOp.Kind, at: Double = 100) -> TodoOp { TodoOp(surfaceId: s, todoId: id, kind: kind, at: at) }

    func testAnOpRoundTripsThroughItsIntent() {
        for kind: TodoOp.Kind in [.create(text: "a", orderKey: "4"), .text("b"), .status(.completed, orderKey: nil), .status(.active, orderKey: "7"), .move(orderKey: "3")] {
            let original = op("t1", kind)
            let intent = Intent(kind: original.intentKind, target: "t1", value: original.value, createdAt: 5)
            XCTAssertEqual(TodoOp(intent), original)
            XCTAssertTrue(intent.kind.isTodo)
        }
        XCTAssertNil(TodoOp(Intent(kind: .read, target: "a", createdAt: 1)))
    }

    func testPendingChangesLieOverWhatTheComputerSaid() {
        let confirmed = ["a": todo("a", "Milk", key: "3"), "b": todo("b", "Eggs", key: "6")]
        let ops = [
            op("n", .create(text: "Bread", orderKey: "1")),
            op("a", .text("Oat milk")),
            op("b", .status(.completed, orderKey: nil), at: 150),
            op("n", .text("Rye bread")),
        ]
        let split = TodoReducer.split(TodoReducer.overlay(confirmed, ops))
        XCTAssertEqual(split.active.map(\.text), ["Rye bread", "Oat milk"])
        XCTAssertEqual(split.completed.map(\.text), ["Eggs"])
        XCTAssertEqual(split.completed.first?.completedAt, 150)
        XCTAssertNil(split.completed.first?.orderKey)
    }

    func testDeleteThenRestoreAndMovesKeepTheirPlace() {
        var shown = ["a": todo("a", key: "3"), "b": todo("b", key: "6")]
        shown = TodoReducer.overlay(shown, [op("a", .status(.deleted, orderKey: nil))])
        XCTAssertEqual(shown["a"]?.status, .deleted)
        XCTAssertEqual(shown["a"]?.deletedAt, 100)
        shown = TodoReducer.overlay(shown, [op("a", .status(.active, orderKey: "2"))])
        XCTAssertEqual(TodoReducer.split(shown).active.map(\.id), ["a", "b"])
        XCTAssertNil(shown["a"]?.deletedAt)
        shown = TodoReducer.overlay(shown, [op("a", .move(orderKey: "7"))])
        XCTAssertEqual(TodoReducer.split(shown).active.map(\.id), ["b", "a"])
    }

    func testOnlyANewerTodoIsTaken() {
        var confirmed = ["a": todo("a", "New", version: "0003")]
        XCTAssertFalse(TodoReducer.accept(todo("a", "Old", version: "0002"), into: &confirmed))
        XCTAssertFalse(TodoReducer.accept(todo("a", "Same", version: "0003"), into: &confirmed))
        XCTAssertTrue(TodoReducer.accept(todo("a", "Newer", version: "0004"), into: &confirmed))
        XCTAssertEqual(confirmed["a"]?.text, "Newer")
    }

    func testEventsFollowTheVersionChainAndAskForAReadWhereItBreaks() {
        var confirmed = ["a": todo("a", "Milk", version: "0001")]
        func updated(_ id: String, previous: String, version: String, _ changes: [String: JSONValue], surface: String? = nil) -> JSONValue {
            .object(["type": "todo.updated", "payload": .object(["surfaceId": .string(surface ?? s), "todoId": .string(id), "previousVersion": .string(previous), "version": .string(version), "changes": .object(changes)])])
        }
        XCTAssertEqual(TodoReducer.receive(updated("a", previous: "0001", version: "0002", ["status": "completed", "orderKey": .null, "completedAt": 50, "updatedAt": 50]), surfaceId: s, into: &confirmed), .applied)
        XCTAssertEqual(confirmed["a"]?.status, .completed)
        XCTAssertNil(confirmed["a"]?.orderKey)
        XCTAssertEqual(confirmed["a"]?.version, "0002")
        XCTAssertEqual(TodoReducer.receive(updated("a", previous: "0001", version: "0002", ["text": "dup"]), surfaceId: s, into: &confirmed), .ignored, "already held")
        XCTAssertEqual(TodoReducer.receive(updated("a", previous: "0003", version: "0004", ["text": "gap"]), surfaceId: s, into: &confirmed), .read("a"))
        XCTAssertEqual(TodoReducer.receive(updated("z", previous: "0001", version: "0002", [:]), surfaceId: s, into: &confirmed), .read("z"))
        XCTAssertEqual(TodoReducer.receive(updated("a", previous: "0002", version: "0003", [:], surface: "other"), surfaceId: s, into: &confirmed), .ignored)
        let created: JSONValue = .object(["type": "todo.created", "payload": .object(["todo": .object([
            "id": "b", "surfaceId": .string(s), "text": "Eggs", "status": "active", "orderKey": "1", "createdAt": 1, "updatedAt": 1,
            "completedAt": .null, "deletedAt": .null, "version": "0001", "authorUserId": "u1",
        ])])])
        XCTAssertEqual(TodoReducer.receive(created, surfaceId: s, into: &confirmed), .applied)
        XCTAssertEqual(confirmed["b"]?.authorUserId, "u1")
    }

    func testAChangeTheComputerAlreadyHasIsNotSent() {
        let confirmed = ["a": todo("a", "Milk", key: "3"), "b": todo("b", key: "6"), "d": todo("d", "x", .deleted)]
        XCTAssertFalse(TodoReducer.needed(op("a", .text("Milk")), confirmed: confirmed, shown: confirmed))
        XCTAssertTrue(TodoReducer.needed(op("a", .text("Oat milk")), confirmed: confirmed, shown: confirmed))
        XCTAssertFalse(TodoReducer.needed(op("a", .create(text: "Milk", orderKey: "1")), confirmed: confirmed, shown: confirmed))
        XCTAssertTrue(TodoReducer.needed(op("n", .create(text: "New", orderKey: "1")), confirmed: confirmed, shown: confirmed))
        XCTAssertFalse(TodoReducer.needed(op("d", .text("edit a deleted one")), confirmed: confirmed, shown: confirmed))
        XCTAssertTrue(TodoReducer.needed(op("d", .status(.active, orderKey: "9")), confirmed: confirmed, shown: confirmed))
        XCTAssertFalse(TodoReducer.needed(op("d", .status(.deleted, orderKey: nil)), confirmed: confirmed, shown: confirmed))
        // A move is needed only where it changes what comes before it.
        let moved = TodoReducer.overlay(confirmed, [op("a", .move(orderKey: "7"))])
        XCTAssertTrue(TodoReducer.needed(op("a", .move(orderKey: "7")), confirmed: confirmed, shown: moved))
        let same = TodoReducer.overlay(confirmed, [op("a", .move(orderKey: "2"))])
        XCTAssertFalse(TodoReducer.needed(op("a", .move(orderKey: "2")), confirmed: confirmed, shown: same))
        XCTAssertEqual(TodoReducer.after("a", in: moved), "b")
        XCTAssertNil(TodoReducer.after("b", in: moved))
    }

    func testAMoveFindsAKeyBetweenItsNewNeighbours() throws {
        let active = [todo("a", key: "2"), todo("b", key: "4"), todo("c", key: "6")]
        let key = try XCTUnwrap(TodoReducer.key(moving: "a", to: 2, in: active))
        XCTAssertTrue(TodoOrder.precedes("6", key))
        let middle = try XCTUnwrap(TodoReducer.key(moving: "c", to: 1, in: active))
        XCTAssertTrue(TodoOrder.precedes("2", middle) && TodoOrder.precedes(middle, "4"))
        XCTAssertNil(TodoReducer.key(moving: "b", to: 1, in: active), "already there")
    }

    func testEachRevisionSaysWhatItChanged() {
        func revision(_ text: String, _ status: TodoItem.Status, key: String? = "5") -> TodoRevision { TodoRevision(todo: todo("a", text, status, key: key)) }
        let changes = TodoRevision.changes([
            revision("Milk", .active), revision("Oat milk", .active), revision("Oat milk", .completed), revision("Oat milk", .active),
            revision("Oat milk", .active, key: "9"), revision("Oat milk", .deleted), revision("Soy milk", .active),
        ])
        XCTAssertEqual(changes, [.created, .edited(from: "Milk"), .completed, .reopened, .moved, .deleted, .editedAnd(.restored)])
    }
}
