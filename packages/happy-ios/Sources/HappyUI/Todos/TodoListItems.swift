#if canImport(UIKit)
import Foundation
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// What a todo list's rows derive from: the library's state and what the
/// screen decides (the view, the completed fold, the row being edited,
/// the todos just checked, a drag's order, the width and theme).
struct TodoListInput: Sendable {
    enum Mode: Sendable { case list, deleted }

    var state = TodoListState()
    var mode = Mode.list
    var completedShown = false
    /// The todo whose text is being edited, or `TodoListItems.addID`.
    var editingID: String?
    /// Just checked: shown done where they were for a moment, as each was.
    var settling: [String: TodoItem] = [:]
    /// The active todos in the order a drag shows them.
    var dragOrder: [String]?
    var width: CGFloat = 0
    var maxWidth: CGFloat = .greatestFiniteMagnitude
    var scale: CGFloat = 1
    var displayScale: CGFloat = 2
    var dark = false
}

/// Where a row's parts are, for a tap or a drag: by row ID.
struct TodoRowGeometry: Equatable, Sendable {
    var check: CGRect?
    var hit: CGRect?
    var text: CGRect?
}

/// A todo list's rows, worked out off the main thread, as desktop's todo
/// Surface shows them: the field to add one, then the active todos, each
/// section heading (`# Groceries`) over a card of its own, then "Show N
/// completed" and, opened, the completed ones. Or, in the deleted view,
/// the deleted ones newest first.
enum TodoListItems {
    static let addID = "todo:add"
    static let failureID = "todo:failure"
    static let toggleID = "todo:toggle"
    static let editorKey = "editor"

    static func rowID(_ todoID: String) -> String { "todo:\(todoID)" }
    /// The todo a row shows; nil for the field, a heading's gap, a note.
    static func todoID(_ rowID: String) -> String? {
        guard rowID.hasPrefix("todo:") else { return nil }
        let id = rowID.dropFirst(5)
        return id.count == 24 && !id.contains(":") ? String(id) : nil
    }

    struct Output: Sendable {
        var items: [CardItem]
        var geometry: [String: TodoRowGeometry]
        /// The active todos in the order shown.
        var active: [String]
    }

    private struct Context {
        let input: TodoListInput
        var items: [CardItem] = []
        var geometry: [String: TodoRowGeometry] = [:]
        var hairline: CGFloat { 1 / max(1, input.displayScale) }
        var text: CardFont { CardFont(.regular, TodoMetrics.textSize, scale: input.scale) }
        var heading: CardFont { CardFont(.semiBold, TodoMetrics.headingSize, scale: input.scale) }
        var small: CardFont { CardFont(.regular, CardListMetrics.subtitleSize, scale: input.scale) }
        func drawing() -> CardDrawing { CardDrawing(dark: input.dark, displayScale: input.displayScale) }

        mutating func note(_ id: String, _ words: String) {
            items.append(CardItems.note(id, words, width: input.width, maxWidth: input.maxWidth, scale: input.scale, dark: input.dark, displayScale: input.displayScale))
        }
    }

    nonisolated static func items(_ input: TodoListInput) -> Output {
        guard input.width > 0 else { return Output(items: [], geometry: [:], active: []) }
        var context = Context(input: input)
        let state = input.state
        if let failure = state.failure { notice(&context, failure) }
        switch input.mode {
        case .deleted:
            deleted(&context)
            return Output(items: context.items, geometry: context.geometry, active: [])
        case .list:
            break
        }
        if state.status == .missing {
            context.note("todo:missing", Strings.Todos.missing)
            return Output(items: context.items, geometry: context.geometry, active: [])
        }
        add(&context)
        let active = shownActive(input)
        let completed = state.completed.filter { input.settling[$0.id] == nil }
        if active.isEmpty, completed.isEmpty {
            context.note("todo:empty", state.status == .loading ? Strings.Todos.loading : Strings.Todos.empty)
        }
        // Each heading starts a card of the todos under it.
        var run: [TodoItem] = []
        func flush() {
            for (todo, place) in zip(run, CardPlace.run(run.count)) { row(&context, todo, place: place, done: input.settling[todo.id] != nil) }
            run = []
        }
        for todo in active {
            if todo.heading != nil {
                flush()
                heading(&context, todo, afterCard: true)
            } else {
                run.append(todo)
            }
        }
        flush()
        if !completed.isEmpty {
            toggle(&context, count: completed.count, shown: input.completedShown)
            if input.completedShown {
                for (todo, place) in zip(completed, CardPlace.run(completed.count)) { row(&context, todo, place: place, done: true) }
            }
        }
        return Output(items: context.items, geometry: context.geometry, active: active.map(\.id))
    }

    /// The active todos in the order shown: a drag's, and with those just
    /// checked still in their places.
    nonisolated static func shownActive(_ input: TodoListInput) -> [TodoItem] {
        var active = input.state.active
        let settling = input.settling.values.filter { todo in !active.contains { $0.id == todo.id } && input.state.completed.contains { $0.id == todo.id } }
        if !settling.isEmpty { active = (active + settling).sorted(by: TodoOrder.active) }
        guard let order = input.dragOrder else { return active }
        let byID = Dictionary(active.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let ordered = order.compactMap { byID[$0] }
        return ordered + active.filter { !order.contains($0.id) }
    }

    // MARK: Rows

    private nonisolated static func notice(_ context: inout Context, _ reason: String) {
        let input = context.input
        let words = Strings.Todos.failure(reason)
        let layout = CardRowLayout(
            width: input.width, maxWidth: input.maxWidth, place: .alone, leading: CGSize(width: 20, height: 20),
            title: CardText.measurable(words, font: context.small, maxLines: 0, scale: input.displayScale), hairline: context.hairline, scale: input.displayScale
        )
        var drawing = context.drawing()
        if let frame = layout.leading { drawing.icon(.ionicons("alert-circle"), size: 20, Palette.todoNotice, in: frame) }
        drawing.text(words, context.small, Palette.text, layout.title, wraps: true)
        var item = CardItem(id: failureID, kind: .row, size: layout.size, card: layout.card, drawing: drawing, opens: true)
        item.accessibilityLabel = words
        item.accessibilityValue = Strings.Todos.dismiss
        context.items.append(item)
        gap(&context, "todo:gap:failure")
    }

    private nonisolated static func gap(_ context: inout Context, _ id: String) {
        context.items.append(CardItem(id: id, kind: .note, size: CGSize(width: context.input.width, height: CardListMetrics.headingGap), drawing: context.drawing()))
    }

    private nonisolated static func add(_ context: inout Context) {
        let input = context.input
        let editing = input.editingID == addID
        let layout = TodoRowLayout(
            width: input.width, maxWidth: input.maxWidth, place: .alone,
            text: CardText.measurable(Strings.Todos.add, font: context.text, maxLines: 1, scale: input.displayScale),
            textLine: CardText.line(context.text, scale: input.displayScale), face: false, hairline: context.hairline, scale: input.displayScale
        )
        var drawing = context.drawing()
        drawing.icon(.ionicons("add"), size: TodoMetrics.check, Palette.todoCheck, in: layout.check)
        if !editing { drawing.text(Strings.Todos.add, context.text, Palette.settingsSecondary, layout.text) }
        var item = CardItem(id: addID, kind: .row, size: layout.size, card: layout.card, drawing: drawing, opens: !editing)
        if editing { item.overlays = [CardOverlay(kind: editorKey, key: editorKey, frame: editorFrame(layout))] }
        item.accessibilityLabel = Strings.Todos.add
        context.items.append(item)
        context.geometry[addID] = TodoRowGeometry(text: layout.text)
        gap(&context, "todo:gap:add")
    }

    /// The field over a row's text: its first line, a little taller to
    /// take a finger, as wide as the text.
    private nonisolated static func editorFrame(_ layout: TodoRowLayout) -> CGRect {
        let height = max(layout.check.height + 8, 34)
        return CGRect(x: layout.text.minX, y: (layout.check.midY - height / 2).rounded(), width: layout.text.width, height: height)
    }

    private nonisolated static func heading(_ context: inout Context, _ todo: TodoItem, afterCard: Bool) {
        let input = context.input
        let label = todo.heading ?? todo.text
        let editing = input.editingID == todo.id
        let layout = TodoHeadingLayout(width: input.width, maxWidth: input.maxWidth, label: CardText.measurable(label.isEmpty ? " " : label, font: context.heading, maxLines: TodoMetrics.headingLines, scale: input.displayScale), afterCard: afterCard)
        var drawing = context.drawing()
        if !editing { drawing.text(label, context.heading, Palette.text, layout.label, wraps: true) }
        var item = CardItem(id: rowID(todo.id), kind: .heading, size: layout.size, drawing: drawing, opens: !editing)
        if editing {
            item.overlays = [CardOverlay(kind: editorKey, key: editorKey, frame: CGRect(x: layout.label.minX, y: layout.label.minY - 4, width: layout.label.width, height: max(34, CardText.line(context.heading, scale: input.displayScale) + 8)))]
        }
        item.accessibilityLabel = label
        item.accessibilityValue = Strings.Todos.heading
        context.items.append(item)
        context.geometry[item.id] = TodoRowGeometry(text: layout.label)
    }

    private nonisolated static func row(_ context: inout Context, _ todo: TodoItem, place: CardPlace, done: Bool) {
        let input = context.input
        let editing = input.editingID == todo.id
        let name = todo.authorUserId.flatMap { input.state.names[$0] }
        let text = todo.heading.map { "# \($0)" } ?? todo.text
        let layout = TodoRowLayout(
            width: input.width, maxWidth: input.maxWidth, place: place,
            text: CardText.measurable(text.isEmpty ? " " : text, font: context.text, maxLines: TodoMetrics.textLines, scale: input.displayScale),
            textLine: CardText.line(context.text, scale: input.displayScale), face: name != nil, hairline: context.hairline, scale: input.displayScale
        )
        var drawing = context.drawing()
        if done {
            drawing.marks.append(.tile(layout.check, radius: TodoMetrics.check / 2, Palette.todoCheck))
            drawing.icon(.ionicons("checkmark"), size: TodoMetrics.checkGlyph, Palette.onAccent, in: layout.check)
        } else {
            drawing.marks.append(.ring(layout.check, width: TodoMetrics.checkStroke, Palette.todoRing))
        }
        if !editing { drawing.text(text, context.text, done ? Palette.settingsSecondary : Palette.text, layout.text, wraps: true, strike: done) }
        if let name, let frame = layout.face { face(&drawing, name: name, seed: todo.authorUserId ?? name, in: frame, scale: input.scale) }
        drawing.rule(layout.separator)
        var item = CardItem(id: rowID(todo.id), kind: .row, size: layout.size, card: layout.card, place: place, drawing: drawing, opens: !editing)
        if editing { item.overlays = [CardOverlay(kind: editorKey, key: editorKey, frame: editorFrame(layout))] }
        item.accessibilityLabel = text
        var value = [done ? Strings.Todos.done : Strings.Todos.notDone]
        if let name { value.append(Strings.Todos.addedBy(name)) }
        if input.state.waiting.contains(todo.id) { value.append(Strings.Todos.notSent) }
        item.accessibilityValue = value.joined(separator: ", ")
        context.items.append(item)
        context.geometry[item.id] = TodoRowGeometry(check: layout.check, hit: layout.hit, text: layout.text)
    }

    /// Who added it: their initials on a colour their ID picks.
    private nonisolated static func face(_ drawing: inout CardDrawing, name: String, seed: String, in frame: CGRect, scale: CGFloat) {
        let looks: [(ColorToken, ColorToken)] = [
            (Palette.tileBlue, Palette.tileBlueFill), (Palette.tileGreen, Palette.tileGreenFill), (Palette.tileOrange, Palette.tileOrangeFill),
            (Palette.tileIndigo, Palette.tileIndigoFill), (Palette.tilePurple, Palette.tilePurpleFill), (Palette.tileTeal, Palette.tileTealFill),
        ]
        let look = looks[seed.utf8.reduce(0) { ($0 &* 31 &+ Int($1)) & 0xFFFF } % looks.count]
        drawing.marks.append(.tile(frame, radius: frame.width / 2, look.1))
        let initials = String(name.split(separator: " ").prefix(2).compactMap(\.first)).uppercased()
        let font = CardFont(.semiBold, TodoMetrics.faceText)
        let size = CardText.measure(initials, font: font, width: frame.width, maxLines: 1, scale: 2)
        drawing.text(initials, font, look.0, CGRect(x: frame.midX - size.width / 2, y: frame.midY - size.height / 2, width: size.width, height: size.height))
    }

    private nonisolated static func toggle(_ context: inout Context, count: Int, shown: Bool) {
        let input = context.input
        let words = shown ? Strings.Todos.hideCompleted(count) : Strings.Todos.showCompleted(count)
        let font = CardFont(.medium, CardListMetrics.subtitleSize + 2, scale: input.scale)
        let size = CardText.measure(words, font: font, width: 10_000, maxLines: 1, scale: input.displayScale)
        let layout = TodoToggleLayout(width: input.width, maxWidth: input.maxWidth, label: size, afterCard: true)
        var drawing = context.drawing()
        drawing.icon(.ionicons(shown ? "chevron-down" : "chevron-forward"), size: TodoMetrics.toggleChevron, Palette.settingsSecondary, in: layout.chevron)
        drawing.text(words, font, Palette.settingsSecondary, layout.label)
        var item = CardItem(id: toggleID, kind: .heading, size: layout.size, drawing: drawing, opens: true)
        item.accessibilityLabel = words
        context.items.append(item)
    }

    private nonisolated static func deleted(_ context: inout Context) {
        let input = context.input
        let deleted = input.state.deleted
        guard !deleted.isEmpty else {
            context.note("todo:deleted:empty", input.state.deletedRead && !input.state.kept ? Strings.Todos.deletedEmpty : Strings.Todos.deletedLoading)
            return
        }
        for (todo, place) in zip(deleted, CardPlace.run(deleted.count)) {
            let text = todo.text
            let layout = CardRowLayout(
                width: input.width, maxWidth: input.maxWidth, place: place,
                title: CardText.measurable(text, font: context.text, maxLines: TodoMetrics.textLines, scale: input.displayScale),
                hairline: context.hairline, scale: input.displayScale
            )
            var drawing = context.drawing()
            drawing.text(text, context.text, Palette.settingsSecondary, layout.title, wraps: true)
            drawing.rule(layout.separator)
            var item = CardItem(id: rowID(todo.id), kind: .row, size: layout.size, card: layout.card, place: place, drawing: drawing, opens: true)
            item.accessibilityLabel = text
            item.accessibilityValue = Strings.Todos.restore
            context.items.append(item)
        }
    }
}
#endif
